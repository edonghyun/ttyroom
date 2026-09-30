package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.ttyroom.application.RoomNotice.*;
import dev.ttyroom.domain.HostPresence;
import dev.ttyroom.domain.LeaseControl;
import dev.ttyroom.domain.RoomControl.InputRejection;
import dev.ttyroom.domain.TerminalWorkspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.stream.Stream;

class RoomPersistenceTests {
    @Test
    void unavailableRecipientDoesNotUndoCommittedRenameOrBlockOtherRecipients() {
        try (var fixture = Fixture.editableRoom()) {
            var savesBefore = fixture.store.saves.size();
            fixture.alice.sendFailure = new RoomSessions.PeerUnavailable("transport unavailable");

            fixture.alice.renameTerminal(7, "Saved");

            assertStoredTerminalTitle(fixture.savedRecord(), 7, "Saved");
            assertStoredTerminalTitle(fixture.record(), 7, "Saved");
            assertThat(fixture.store.saves).hasSize(savesBefore + 1);
            assertThat(fixture.observer.noticesOf(TerminalRenamed.class))
                    .containsExactly(new TerminalRenamed(7, "Saved"));
            assertThat(fixture.alice.closed).isTrue();
            assertThat(fixture.observer.closed).isFalse();
        }
    }

    @Test
    void unexpectedDeliveryFailurePropagatesWithoutUndoingOrRepeatingCommittedRename() {
        try (var fixture = Fixture.editableRoom()) {
            var savesBefore = fixture.store.saves.size();
            var deliveryFailure = new IllegalStateException("broken peer implementation");
            fixture.alice.sendFailure = deliveryFailure;

            var failure = catchThrowable(() -> fixture.alice.renameTerminal(7, "Saved"));

            assertThat(failure).isSameAs(deliveryFailure);
            assertStoredTerminalTitle(fixture.savedRecord(), 7, "Saved");
            assertStoredTerminalTitle(fixture.record(), 7, "Saved");
            assertThat(fixture.store.saves).hasSize(savesBefore + 1);
        }
    }

    @Test
    void waitingOnAnUnrelatedLatchDoesNotCountAsAnAcceptedRoomCommand() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var unrelated =
                    PendingCall.start(
                            () -> {
                                entered.countDown();
                                try {
                                    release.await();
                                } catch (InterruptedException interrupted) {
                                    Thread.currentThread().interrupt();
                                    throw new IllegalStateException(interrupted);
                                }
                            });
            Throwable failure;
            try {
                awaitLatch(entered);
                failure = catchThrowable(() -> fixture.awaitRoomQueued(unrelated));
            } finally {
                release.countDown();
                unrelated.await();
            }

            assertThat(failure)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("Command did not enter room command queue");
        }
    }

    @Test
    void creationIsInvisibleUntilSaveAndFailedCreationDoesNotLeaveAnInvitation() throws Exception {
        try (var fixture = Fixture.emptyRoom()) {
            var gate = fixture.store.nextSave();
            var creating = PendingCall.start(() -> fixture.rooms.create("New"));
            gate.awaitEntered();
            var candidate = gate.record;
            var hidden =
                    catchThrowable(
                            () -> fixture.rooms.authenticatedRoom(candidate.roomId(), "unknown"));

            gate.fail();
            var failed = creating.failure();
            var after =
                    catchThrowable(
                            () -> fixture.rooms.authenticatedRoom(candidate.roomId(), "unknown"));
            var next = fixture.rooms.create("Next");

            assertThat(hidden)
                    .isInstanceOfSatisfying(
                            RoomDirectory.InvitationRejected.class,
                            error -> assertThat(error.code()).isEqualTo("room-not-found"));
            assertThat(after)
                    .isInstanceOfSatisfying(
                            RoomDirectory.InvitationRejected.class,
                            error -> assertThat(error.code()).isEqualTo("room-not-found"));
            assertThat(failed).isSameAs(gate.failure);
            assertThat(fixture.store.records).doesNotContainKey(candidate.roomId());
            assertThat(fixture.rooms.acceptsToken(next.roomId(), next.token())).isTrue();
        }
    }

    @Test
    void pendingSaveKeepsTheCommittedViewWhileRealtimeProceeds() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            fixture.alice.send(new ParticipantCommand.AcquireLease(7));
            fixture.host.send(new HostCommand.InputState(true));
            var before = fixture.record();
            var gate = fixture.store.nextSave();

            var rename = PendingCall.start(() -> fixture.alice.renameTerminal(7, "Saved"));
            gate.awaitEntered();
            var pendingView = fixture.record();
            var pendingNotices = List.copyOf(fixture.observer.notices);
            var realtime =
                    PendingCall.start(
                            () -> {
                                fixture.alice.session.input(
                                        new InputFrame(7, 1, 1, new byte[] {66}));
                                fixture.host.session.output(new OutputFrame(7, 1, new byte[] {65}));
                                fixture.alice.send(
                                        new ParticipantCommand.MoveCursor(
                                                new CursorPosition(1, 2)));
                            });
            realtime.await();
            gate.succeed();
            rename.await();

            assertThat(pendingView).isEqualTo(before);
            assertThat(pendingNotices).noneMatch(TerminalRenamed.class::isInstance);
            assertThat(fixture.host.inputs).hasSize(1);
            assertThat(fixture.observer.frames).hasSize(1);
            assertThat(fixture.observer.notices)
                    .contains(new ParticipantCursor("alice", new CursorPosition(1, 2)));
            assertThat(fixture.record()).isEqualTo(fixture.savedRecord());
        }
    }

    @Test
    void anotherRoomCanCommitWhileThisRoomsSaveWaits() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var otherRoom = fixture.rooms.create("Other");
            var otherHost = fixture.join(otherRoom, "other-host", RoomSessions.Role.HOST);
            otherHost.inventory(7, "other-runtime");
            var otherAlice = fixture.join(otherRoom, "other-alice", RoomSessions.Role.PARTICIPANT);
            var gate = fixture.store.nextSave();

            var saving = PendingCall.start(() -> fixture.alice.renameTerminal(7, "Saved"));
            gate.awaitEntered();
            var independent = PendingCall.start(() -> otherAlice.renameTerminal(7, "Other saved"));
            independent.await();
            var otherSaved = fixture.store.records.get(otherRoom.roomId());
            gate.succeed();
            saving.await();

            assertStoredTerminalTitle(otherSaved, 7, "Other saved");
        }
    }

    @Test
    void queuedRenameCommitsAndPublishesAfterTheEarlierSave() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var gate = fixture.store.nextSave();

            var first = PendingCall.start(() -> fixture.alice.renameTerminal(7, "Saved"));
            gate.awaitEntered();
            var later = PendingCall.start(() -> fixture.alice.renameTerminal(7, "Later"));
            fixture.awaitRoomQueued(later);
            gate.succeed();
            first.await();
            later.await();

            assertThat(fixture.observer.noticesOf(TerminalRenamed.class))
                    .containsExactly(
                            new TerminalRenamed(7, "Saved"), new TerminalRenamed(7, "Later"));
            assertStoredTerminalTitle(fixture.savedRecord(), 7, "Later");
            assertThat(fixture.record()).isEqualTo(fixture.savedRecord());
        }
    }

    @Test
    void leaseAcquisitionWaitsForModeCommitAndRejectsTheNowSharedTerminal() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var gate = fixture.store.nextSave();

            var modeChange =
                    PendingCall.start(
                            () ->
                                    fixture.alice.send(
                                            new ParticipantCommand.SetTerminalMode(
                                                    7, TerminalWorkspace.Mode.SHARED)));
            gate.awaitEntered();
            var acquisition =
                    PendingCall.start(
                            () -> fixture.observer.send(new ParticipantCommand.AcquireLease(7)));
            fixture.awaitRoomQueued(acquisition);
            gate.succeed();
            modeChange.await();
            acquisition.await();
            var after = fixture.welcome();

            assertThat(fixture.observer.notices)
                    .containsSubsequence(
                            new TerminalModeChanged(7, TerminalWorkspace.Mode.SHARED),
                            new LeaseInvalid(7, InputRejection.TERMINAL_CLOSED));
            assertThat(fixture.observer.notices).noneMatch(LeaseGranted.class::isInstance);
            assertThat(after.leases()).isEmpty();
        }
    }

    @Test
    void failedReservationDoesNotConsumeIdLeaseOrSendHostCommandAndTheNextCommandRuns()
            throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            fixture.alice.send(new ParticipantCommand.AcquireLease(7));
            var before = fixture.record();
            var hostBefore = List.copyOf(fixture.host.notices);
            var gate = fixture.store.nextSave();

            var opening =
                    PendingCall.start(
                            () -> fixture.alice.send(new ParticipantCommand.OpenTerminal("host")));
            gate.awaitEntered();
            gate.fail();
            var failure = opening.failure();
            var afterFailure = fixture.record();
            var hostAfterFailure = List.copyOf(fixture.host.notices);
            fixture.alice.send(new ParticipantCommand.OpenTerminal("host"));
            var welcome = fixture.welcome();

            assertThat(failure).isSameAs(gate.failure);
            assertThat(afterFailure).isEqualTo(before);
            assertThat(hostAfterFailure).isEqualTo(hostBefore);
            assertThat(fixture.host.notices.getLast()).isEqualTo(new OpenTerminal(8));
            assertThat(welcome.leases()).containsExactly(new LeaseControl.Lease(7, 1, "alice"));
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("liveChanges")
    void liveChangePublishesItsNoticeWithoutWritingStorage(
            String name, Consumer<Fixture> action, RoomNotice expectedNotice) {
        try (var fixture = Fixture.editableRoom()) {
            var savesBefore = fixture.store.saves.size();
            var noticesBefore = fixture.observer.notices.size();

            action.accept(fixture);
            var published = fixture.observer.noticesSince(noticesBefore);

            assertThat(fixture.store.saves).hasSize(savesBefore);
            assertThat(published).containsExactly(expectedNotice);
        }
    }

    static Stream<Arguments> liveChanges() {
        return Stream.of(
                liveChange(
                        "lease acquisition",
                        f -> f.alice.send(new ParticipantCommand.AcquireLease(7)),
                        new LeaseGranted(new LeaseControl.Lease(7, 1, "alice"))),
                liveChange(
                        "participant focus",
                        f -> f.alice.send(new ParticipantCommand.FocusTerminal(7L)),
                        new ParticipantFocusChanged("alice", 7L)),
                liveChange(
                        "cursor removal",
                        f -> f.alice.send(new ParticipantCommand.MoveCursor(null)),
                        new ParticipantCursor("alice", null)),
                liveChange(
                        "host input permission",
                        f -> f.host.send(new HostCommand.InputState(true)),
                        new HostInputStateChanged("host", true)));
    }

    private static Arguments liveChange(
            String name, Consumer<Fixture> action, RoomNotice expectedNotice) {
        return Arguments.of(name, action, expectedNotice);
    }

    @Test
    void disconnectingAnInputEnabledHostPublishesOfflineWithoutWritingStorage() {
        try (var fixture = Fixture.editableRoom()) {
            fixture.alice.send(new ParticipantCommand.AcquireLease(7));
            fixture.host.send(new HostCommand.InputState(true));
            var savesBefore = fixture.store.saves.size();
            var noticesBefore = fixture.observer.notices.size();

            fixture.host.session.disconnect();
            var published = fixture.observer.noticesSince(noticesBefore);

            assertThat(fixture.store.saves).hasSize(savesBefore);
            assertThat(published).containsExactly(new HostOffline("host"));
        }
    }

    @Test
    void renamingToTheSameTitleDoesNotWriteOrPublish() {
        try (var fixture = Fixture.editableRoom()) {
            var title = fixture.terminal(7).title();
            var savesBefore = fixture.store.saves.size();
            var noticesBefore = fixture.observer.notices.size();

            fixture.alice.renameTerminal(7, title);
            var published = fixture.observer.noticesSince(noticesBefore);

            assertThat(fixture.store.saves).hasSize(savesBefore);
            assertThat(published).isEmpty();
            assertThat(fixture.alice.noticesOf(Rejected.class)).isEmpty();
        }
    }

    @Test
    void submittingTheSameGeometryPublishesItWithoutWritingStorage() {
        try (var fixture = Fixture.editableRoom()) {
            var geometry = fixture.terminal(7).geometry();
            var savesBefore = fixture.store.saves.size();
            var noticesBefore = fixture.observer.notices.size();

            fixture.alice.send(new ParticipantCommand.UpdateTerminalGeometry(7, geometry));
            var published = fixture.observer.noticesSince(noticesBefore);

            assertThat(fixture.store.saves).hasSize(savesBefore);
            assertThat(published).containsExactly(new TerminalGeometryChanged(7, geometry));
        }
    }

    @Test
    void terminalOutputReachesTheParticipantWithoutWritingStorage() {
        try (var fixture = Fixture.editableRoom()) {
            var savesBefore = fixture.store.saves.size();
            var output = new OutputFrame(7, 1, new byte[] {65});

            fixture.host.session.output(output);

            assertThat(fixture.store.saves).hasSize(savesBefore);
            assertThat(fixture.observer.frames)
                    .singleElement()
                    .usingRecursiveComparison()
                    .isEqualTo(output);
        }
    }

    @Test
    void disconnectDuringInventorySaveCommitsRecoveryWithoutResurrectingOnlineState()
            throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var gate = fixture.store.nextSave();
            var recovering = PendingCall.start(() -> fixture.host.inventory(8, "runtime-8"));
            gate.awaitEntered();
            var beforeDisconnect = List.copyOf(fixture.host.notices);

            fixture.host.session.disconnect();
            gate.succeed();
            recovering.await();
            var welcome = fixture.welcome();

            assertThat(fixture.host.notices).isEqualTo(beforeDisconnect);
            assertThat(welcome.hosts())
                    .containsExactly(new HostPresence.State("host", "host", false, false));
            assertThat(welcome.terminals())
                    .extracting(TerminalWorkspace.Terminal::terminalId)
                    .containsExactly(7L, 8L);
            assertThat(fixture.observer.notices).contains(new TerminalClosed(7));
            assertThat(fixture.record()).isEqualTo(fixture.savedRecord());
        }
    }

    @Test
    void disconnectedTargetDoesNotReceiveTheCreationCommandAfterSave() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var gate = fixture.store.nextSave();
            var opening =
                    PendingCall.start(
                            () -> fixture.alice.send(new ParticipantCommand.OpenTerminal("host")));
            gate.awaitEntered();
            var hostBefore = List.copyOf(fixture.host.notices);

            fixture.host.session.disconnect();
            gate.succeed();
            opening.await();

            assertThat(fixture.host.notices).isEqualTo(hostBefore);
            assertThat(fixture.alice.notices.getLast())
                    .isEqualTo(new Rejected("bad-message", "host is unavailable"));
            assertThat(fixture.record().control().workspace().nextTerminalId()).isEqualTo(9);
            assertThat(fixture.record()).isEqualTo(fixture.savedRecord());
        }
    }

    @Test
    void failedHostRegistrationCannotReplaceTheOldSession() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var replacement = new Probe();
            var before = fixture.record();
            var gate = fixture.store.nextSave();
            var joining =
                    PendingCall.start(
                            () ->
                                    fixture.sessions.join(
                                            new RoomSessions.Hello(
                                                    7,
                                                    fixture.invitation.roomId(),
                                                    fixture.invitation.token(),
                                                    "host",
                                                    "Renamed",
                                                    RoomSessions.Role.HOST),
                                            replacement));
            gate.awaitEntered();

            gate.fail();
            var failure = joining.failure();
            fixture.host.send(new HostCommand.InputState(true));

            assertThat(failure).isSameAs(gate.failure);
            assertThat(replacement.notices).isEmpty();
            assertThat(fixture.host.closed).isFalse();
            assertThat(fixture.record()).isEqualTo(before);
            assertThat(fixture.observer.notices).contains(new HostInputStateChanged("host", true));
        }
    }

    @Test
    void failedHostExpiryKeepsTheWorkspaceAndLeaseUntilASuccessfulRetry() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            fixture.alice.send(new ParticipantCommand.AcquireLease(7));
            fixture.host.session.disconnect();
            var before = fixture.record();
            var gate = fixture.store.nextSave();
            var expiry = PendingCall.start(fixture.expiries.getFirst());
            gate.awaitEntered();

            gate.fail();
            var failure = expiry.failure();
            var failedState = fixture.record();
            var failedWelcome = fixture.welcome();
            fixture.expiries.getFirst().run();
            var afterRetry = fixture.welcome();

            assertThat(failure).isSameAs(gate.failure);
            assertThat(failedState).isEqualTo(before);
            assertThat(failedWelcome.leases())
                    .containsExactly(new LeaseControl.Lease(7, 1, "alice"));
            assertThat(afterRetry.hosts()).isEmpty();
            assertThat(afterRetry.terminals()).isEmpty();
            assertThat(afterRetry.leases()).isEmpty();
        }
    }

    @Test
    void failedFinalDeleteKeepsInvitationWithoutResurrectingExpiredParticipantOrLease()
            throws Exception {
        try (var original = Fixture.editableRoom();
                var fixture = Fixture.restoredRoom(original.record(), original.invitation)) {
            var alice = fixture.join(fixture.invitation, "alice", RoomSessions.Role.PARTICIPANT);
            alice.send(new ParticipantCommand.AcquireLease(7));
            alice.send(new ParticipantCommand.FocusTerminal(7L));
            alice.session.disconnect();
            var gate = fixture.store.nextDelete();
            var expiry = PendingCall.start(fixture.expiries.getFirst());
            gate.awaitEntered();

            gate.fail();
            var failure = expiry.failure();
            var welcome = fixture.welcome();

            assertThat(failure).isSameAs(gate.failure);
            assertThat(
                            fixture.rooms.acceptsToken(
                                    fixture.invitation.roomId(), fixture.invitation.token()))
                    .isTrue();
            assertThat(welcome.participants())
                    .extracting(Participant::clientId)
                    .doesNotContain("alice");
            assertThat(welcome.leases()).isEmpty();
            assertThat(fixture.store.records).containsKey(fixture.invitation.roomId());
        }
    }

    @Test
    void shutdownDrainsAcceptedAndQueuedCommandsBeforeClosingStorage() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var gate = fixture.store.nextSave();
            var first = PendingCall.start(() -> fixture.alice.renameTerminal(7, "First"));
            gate.awaitEntered();
            var queued = PendingCall.start(() -> fixture.alice.renameTerminal(7, "Last"));
            fixture.awaitRoomQueued(queued);
            var shutdown = PendingCall.start(fixture.sessions::close);
            fixture.awaitStorageDrain(shutdown);
            var closedWhileSaving = fixture.store.closed;
            var late = catchThrowable(() -> fixture.rooms.create("Too late"));

            gate.succeed();
            first.await();
            queued.await();
            shutdown.await();

            assertThat(closedWhileSaving).isFalse();
            assertThat(late).isInstanceOf(IllegalStateException.class);
            assertThat(fixture.store.closed).isTrue();
            assertStoredTerminalTitle(
                    fixture.store.closedRecords.get(fixture.invitation.roomId()), 7, "Last");
            assertThat(fixture.observer.notices).contains(new TerminalRenamed(7, "Last"));
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("durableCommands")
    void eachDurableMutationWithholdsStateAndNoticesOnStorageFailure(
            String name, Consumer<Fixture> action) throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var before = fixture.record();
            var hostNotices = List.copyOf(fixture.host.notices);
            var participantNotices = List.copyOf(fixture.observer.notices);
            var gate = fixture.store.nextSave();

            var changing = PendingCall.start(() -> action.accept(fixture));
            gate.awaitEntered();
            var during = fixture.record();
            gate.fail();
            var failure = changing.failure();
            var failed = fixture.record();
            var failedHostNotices = List.copyOf(fixture.host.notices);
            var failedParticipantNotices = List.copyOf(fixture.observer.notices);
            action.accept(fixture);
            var committed = fixture.record();

            assertThat(during).isEqualTo(before);
            assertThat(failed).isEqualTo(before);
            assertThat(failure).isSameAs(gate.failure);
            assertThat(failedHostNotices).isEqualTo(hostNotices);
            assertThat(failedParticipantNotices).isEqualTo(participantNotices);
            assertThat(committed).isNotEqualTo(before).isEqualTo(fixture.savedRecord());
        }
    }

    static Stream<Arguments> durableCommands() {
        return Stream.of(
                mutation(
                        "rename",
                        f -> f.alice.send(new ParticipantCommand.RenameTerminal(7, "Changed"))),
                mutation(
                        "geometry",
                        f ->
                                f.alice.send(
                                        new ParticipantCommand.UpdateTerminalGeometry(
                                                7,
                                                new TerminalWorkspace.Geometry(1, 2, 800, 600)))),
                mutation(
                        "mode",
                        f ->
                                f.alice.send(
                                        new ParticipantCommand.SetTerminalMode(
                                                7, TerminalWorkspace.Mode.SHARED))),
                mutation(
                        "reservation",
                        f -> f.alice.send(new ParticipantCommand.OpenTerminal("host"))),
                mutation(
                        "opening confirmation",
                        f -> f.host.send(new HostCommand.TerminalOpened(7, "new-runtime"))),
                mutation("exit", f -> f.host.send(new HostCommand.TerminalClosed(7, 9.0))),
                mutation(
                        "metadata",
                        f ->
                                f.host.send(
                                        new HostCommand.TerminalMetadata(
                                                7,
                                                new TerminalWorkspace.Metadata(
                                                        "/work", "main", "java")))),
                mutation("inventory", f -> f.host.inventory(8, "runtime-8")));
    }

    private static Arguments mutation(String name, Consumer<Fixture> action) {
        return Arguments.of(name, action);
    }

    @Test
    void savedRegistrationSurvivesWelcomeFailureWhileStorageFailurePublishesNothing() {
        try (var fixture = Fixture.editableRoom()) {
            var failed = new Probe();
            failed.sendFailure = new RoomSessions.PeerUnavailable("Welcome unavailable");

            var joined =
                    fixture.sessions.join(
                            new RoomSessions.Hello(
                                    7,
                                    fixture.invitation.roomId(),
                                    fixture.invitation.token(),
                                    "host",
                                    "New name",
                                    RoomSessions.Role.HOST),
                            failed);
            var record = fixture.record();

            assertThat(joined).isNull();
            assertThat(failed.closed).isTrue();
            assertThat(fixture.host.closed).isFalse();
            assertThat(record).isEqualTo(fixture.savedRecord());
            assertThat(record.control().hosts().getFirst().name()).isEqualTo("New name");
        }
    }

    @Test
    void hostRemovalAndEmptyRoomDeleteAreSeparateCommits() throws Exception {
        try (var fixture = Fixture.emptyRoom()) {
            var host = fixture.join(fixture.invitation, "host", RoomSessions.Role.HOST);
            host.inventory(7, "runtime-7");
            host.session.disconnect();
            var gate = fixture.store.nextDelete();

            var expiry = PendingCall.start(fixture.expiries.getFirst());
            gate.awaitEntered();
            var removedBeforeDelete = fixture.record();
            gate.fail();
            var failure = expiry.failure();
            var after = fixture.record();

            assertThat(failure).isSameAs(gate.failure);
            assertThat(removedBeforeDelete.control().hosts()).isEmpty();
            assertThat(removedBeforeDelete.control().workspace().terminals()).isEmpty();
            assertThat(after).isEqualTo(removedBeforeDelete).isEqualTo(fixture.savedRecord());
            assertThat(
                            fixture.rooms.acceptsToken(
                                    fixture.invitation.roomId(), fixture.invitation.token()))
                    .isTrue();
        }
    }

    @Test
    void replacementWaitsForCommitAndAnOldExpiryCannotRemoveTheNewConnection() throws Exception {
        try (var fixture = Fixture.editableRoom()) {
            var gate = fixture.store.nextSave();
            var recovering = PendingCall.start(() -> fixture.host.inventory(8, "runtime-8"));
            gate.awaitEntered();
            fixture.host.session.disconnect();
            var oldExpiry = fixture.expiries.getFirst();

            var replacement =
                    PendingCall.start(
                            () -> fixture.join(fixture.invitation, "host", RoomSessions.Role.HOST));
            fixture.awaitRoomQueued(replacement);
            gate.succeed();
            recovering.await();
            var current = replacement.await();
            oldExpiry.run();
            current.send(new HostCommand.InputState(true));
            var welcome = fixture.welcome();

            assertThat(current.closed).isFalse();
            assertThat(welcome.hosts())
                    .containsExactly(new HostPresence.State("host", "host", false, true));
            assertThat(welcome.terminals())
                    .extracting(TerminalWorkspace.Terminal::terminalId)
                    .containsExactly(7L, 8L);
            assertThat(fixture.record()).isEqualTo(fixture.savedRecord());
        }
    }

    @Test
    void loadFailureClosesStorageAndPreservesTheOriginalFailure() {
        var store = mock(RoomStore.class);
        var failure = new IllegalStateException("Cannot load");
        when(store.loadAll()).thenThrow(failure);

        var actual = catchThrowable(() -> new RoomDirectory(store));

        assertThat(actual).isSameAs(failure);
        org.mockito.Mockito.verify(store).close();
    }

    private static void assertStoredTerminalTitle(
            RoomDirectory.StoredRoom stored, long terminalId, String expectedTitle) {
        assertThat(stored).as("stored room").isNotNull();
        assertThat(stored.control().workspace().terminals())
                .as("stored title for terminal %s", terminalId)
                .filteredOn(terminal -> terminal.view().terminalId() == terminalId)
                .extracting(terminal -> terminal.view().title())
                .containsExactly(expectedTitle);
    }

    private static final class Fixture implements AutoCloseable {
        final Store store;
        final RoomDirectory rooms;
        final RoomDirectory.Invitation invitation;
        final List<Runnable> expiries = new CopyOnWriteArrayList<>();
        final RoomSessions sessions;
        Probe host, alice, observer;
        int observerId;

        /** Connected host, one running terminal, and two participants; no lease is held. */
        static Fixture editableRoom() {
            var fixture = emptyRoom();
            try {
                fixture.host = fixture.join(fixture.invitation, "host", RoomSessions.Role.HOST);
                fixture.host.inventory(7, "runtime-7");
                fixture.alice =
                        fixture.join(fixture.invitation, "alice", RoomSessions.Role.PARTICIPANT);
                fixture.observer =
                        fixture.join(fixture.invitation, "observer", RoomSessions.Role.PARTICIPANT);
                return fixture;
            } catch (RuntimeException | Error failure) {
                fixture.close();
                throw failure;
            }
        }

        static Fixture emptyRoom() {
            return new Fixture(null, null);
        }

        static Fixture restoredRoom(
                RoomDirectory.StoredRoom restored, RoomDirectory.Invitation invitation) {
            return new Fixture(restored, invitation);
        }

        private Fixture(RoomDirectory.StoredRoom restored, RoomDirectory.Invitation invitation) {
            store = new Store();
            if (restored != null) store.records.put(restored.roomId(), restored);
            rooms = new RoomDirectory(store);
            this.invitation = invitation == null ? rooms.create("Test") : invitation;
            var timers = mock(ExpiryTimers.class);
            when(timers.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS)))
                    .thenAnswer(
                            call -> {
                                expiries.add(call.getArgument(0));
                                return mock(ExpiryTimers.Cancellation.class);
                            });
            sessions = new RoomSessions(rooms, timers);
        }

        Probe join(RoomDirectory.Invitation room, String id, RoomSessions.Role role) {
            var probe = new Probe();
            probe.session =
                    sessions.join(
                            new RoomSessions.Hello(7, room.roomId(), room.token(), id, id, role),
                            probe);
            if (probe.session == null) throw new IllegalStateException("Fixture admission failed");
            return probe;
        }

        Welcome welcome() {
            return (Welcome)
                    join(invitation, "late-" + observerId++, RoomSessions.Role.PARTICIPANT)
                            .notices
                            .getFirst();
        }

        RoomDirectory.StoredRoom record() {
            return rooms.authenticatedRoom(invitation.roomId(), invitation.token()).durableState();
        }

        RoomDirectory.StoredRoom savedRecord() {
            return store.records.get(invitation.roomId());
        }

        TerminalWorkspace.Terminal terminal(long terminalId) {
            return record().control().workspace().terminals().stream()
                    .map(terminal -> terminal.view())
                    .filter(terminal -> terminal.terminalId() == terminalId)
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException("Fixture terminal is missing"));
        }

        // There is no public admission acknowledgement. Keep this deliberately white-box
        // observation here: the room queue is entered only after the lifetime read lock.
        void awaitRoomQueued(PendingCall<?> call) {
            var room = rooms.authenticatedRoom(invitation.roomId(), invitation.token());
            var commands = lockField(room, "commands", ReentrantLock.class);
            call.awaitQueue(() -> commands.hasQueuedThread(call.thread), "room command queue");
        }

        void awaitStorageDrain(PendingCall<?> call) {
            var lifetime = lockField(rooms, "lifetime", ReentrantReadWriteLock.class);
            call.awaitQueue(() -> lifetime.hasQueuedThread(call.thread), "storage shutdown queue");
        }

        private static <T> T lockField(Object owner, String name, Class<T> type) {
            try {
                var field = owner.getClass().getDeclaredField(name);
                field.setAccessible(true);
                return type.cast(field.get(owner));
            } catch (ReflectiveOperationException failure) {
                throw new IllegalStateException(
                        "Room ordering observation needs updating", failure);
            }
        }

        public void close() {
            store.releaseGates();
            sessions.close();
        }
    }

    private static final class Probe implements RoomSessions.Peer {
        final List<RoomNotice> notices = new CopyOnWriteArrayList<>();
        final List<OutputFrame> frames = new CopyOnWriteArrayList<>();
        final List<InputFrame> inputs = new CopyOnWriteArrayList<>();
        RoomSessions.Session session;
        volatile boolean closed;
        RuntimeException sendFailure;

        void renameTerminal(long terminalId, String title) {
            send(new ParticipantCommand.RenameTerminal(terminalId, title));
        }

        <T extends RoomNotice> List<T> noticesOf(Class<T> type) {
            return notices.stream().filter(type::isInstance).map(type::cast).toList();
        }

        List<RoomNotice> noticesSince(int count) {
            return List.copyOf(notices.subList(count, notices.size()));
        }

        void send(ParticipantCommand command) {
            session.handle(command);
        }

        void send(HostCommand command) {
            session.handle(command);
        }

        void inventory(long id, String runtime) {
            send(new HostCommand.Inventory(List.of(new HostCommand.Runtime(id, runtime, 0, 0))));
        }

        public void send(RoomNotice notice) {
            if (sendFailure != null) throw sendFailure;
            notices.add(notice);
        }

        public void sendInput(InputFrame frame) {
            inputs.add(frame);
        }

        public boolean offerOutput(OutputFrame frame, OutputGap gap) {
            frames.add(frame);
            return true;
        }

        public void replayOutput(List<OutputFrame> replay, Sync boundary, Runnable afterSync) {
            frames.addAll(replay);
            notices.add(boundary);
            afterSync.run();
        }

        public void close() {
            closed = true;
        }
    }

    private static final class Store implements RoomStore {
        final Map<String, RoomDirectory.StoredRoom> records = new ConcurrentHashMap<>();
        final List<RoomDirectory.StoredRoom> saves = new CopyOnWriteArrayList<>();
        final List<Gate> gates = new CopyOnWriteArrayList<>();
        final AtomicReference<Gate> saveGate = new AtomicReference<>();
        final AtomicReference<Gate> deleteGate = new AtomicReference<>();
        volatile boolean closed;
        Map<String, RoomDirectory.StoredRoom> closedRecords;

        Gate nextSave() {
            return next(saveGate);
        }

        Gate nextDelete() {
            return next(deleteGate);
        }

        Gate next(AtomicReference<Gate> target) {
            var gate = new Gate();
            gates.add(gate);
            if (!target.compareAndSet(null, gate))
                throw new IllegalStateException("Unconsumed storage gate");
            return gate;
        }

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.copyOf(records.values());
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (closed) throw new IllegalStateException("Save after close");
            var gate = saveGate.getAndSet(null);
            if (gate != null) {
                gate.record = room;
                gate.block();
            }
            records.put(room.roomId(), room);
            saves.add(room);
        }

        public void delete(String roomId) {
            var gate = deleteGate.getAndSet(null);
            if (gate != null) gate.block();
            records.remove(roomId);
        }

        public void close() {
            closedRecords = Map.copyOf(records);
            closed = true;
        }

        void releaseGates() {
            gates.forEach(Gate::succeed);
        }
    }

    private static final class Gate {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch released = new CountDownLatch(1);
        final RuntimeException failure = new IllegalStateException("Storage unavailable");
        volatile boolean fail;
        RoomDirectory.StoredRoom record;

        void block() {
            entered.countDown();
            awaitLatch(released);
            if (fail) throw failure;
        }

        void awaitEntered() {
            awaitLatch(entered);
        }

        void succeed() {
            released.countDown();
        }

        void fail() {
            fail = true;
            released.countDown();
        }
    }

    private static final class PendingCall<T> {
        final CompletableFuture<T> result = new CompletableFuture<>();
        final Thread thread;

        private PendingCall(Supplier<T> action) {
            thread =
                    Thread.ofPlatform()
                            .daemon()
                            .start(
                                    () -> {
                                        try {
                                            result.complete(action.get());
                                        } catch (Throwable failure) {
                                            result.completeExceptionally(failure);
                                        }
                                    });
        }

        static <T> PendingCall<T> start(Supplier<T> action) {
            return new PendingCall<>(action);
        }

        static PendingCall<Void> start(Runnable action) {
            return start(
                    () -> {
                        action.run();
                        return null;
                    });
        }

        T await() throws Exception {
            return result.get(5, TimeUnit.SECONDS);
        }

        Throwable failure() {
            var failure = catchThrowable(this::await);
            return failure instanceof ExecutionException ? failure.getCause() : failure;
        }

        void awaitQueue(BooleanSupplier queued, String description) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!queued.getAsBoolean()) {
                if (result.isDone() || System.nanoTime() > deadline)
                    throw new IllegalStateException("Command did not enter " + description);
                LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
            }
        }
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS))
                throw new IllegalStateException("Storage gate timed out");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
    }
}

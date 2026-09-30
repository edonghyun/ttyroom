package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.ttyroom.application.RoomNotice.*;
import dev.ttyroom.domain.HostPresence;
import dev.ttyroom.domain.LeaseControl;
import dev.ttyroom.domain.RoomControl.InputRejection;
import dev.ttyroom.domain.TerminalWorkspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

class RoomSessionsTests {
    @Test
    void joiningManyTerminalsReservesOnlyOneHistoryUntilItsSyncDrains() {
        try (var fixture = new Fixture()) {
            fixture.hostWithHistory(4);
            var newcomer = new Peer();
            newcomer.pauseReplay = true;

            fixture.join("newcomer", newcomer);
            int initiallyReserved = newcomer.replayRequests;
            var initialFrames = List.copyOf(newcomer.frames);
            newcomer.drainReplay();
            newcomer.drainReplay();
            newcomer.drainReplay();
            newcomer.drainReplay();

            assertThat(newcomer.closed).isFalse();
            assertThat(initiallyReserved).isEqualTo(1);
            assertThat(initialFrames).extracting(OutputFrame::terminalId).containsExactly(1L);
            assertThat(newcomer.frames)
                    .extracting(OutputFrame::terminalId)
                    .containsExactly(1L, 2L, 3L, 4L);
            assertThat(newcomer.replayCompletions).isEmpty();
        }
    }

    @Test
    void outputDuringRecoveryIsReplayedOnceBeforeThatTerminalsLiveOutput() {
        try (var fixture = new Fixture()) {
            var host = fixture.hostWithHistory(2);
            var newcomer = new Peer();
            newcomer.pauseReplay = true;
            fixture.join("newcomer", newcomer);

            host.session.output(new OutputFrame(2, 2, new byte[] {2}));
            var beforeSecondReplay = List.copyOf(newcomer.frames);
            newcomer.drainReplay();
            host.session.output(new OutputFrame(2, 3, new byte[] {3}));
            newcomer.drainReplay();

            assertThat(beforeSecondReplay).extracting(OutputFrame::terminalId).containsExactly(1L);
            // The old 1 MiB frame is evicted when seq 2 arrives; bounded history stays
            // authoritative.
            assertThat(newcomer.frames)
                    .extracting(OutputFrame::terminalId)
                    .containsExactly(1L, 2L, 2L);
            assertThat(newcomer.frames).extracting(OutputFrame::seq).containsExactly(1L, 2L, 3L);
            assertThat(newcomer.messages)
                    .filteredOn(Sync.class::isInstance)
                    .containsExactly(new Sync(1, 1), new Sync(2, 2));
        }
    }

    @Test
    void lateReplayCompletionCannotAdvanceAReplacedConnection() {
        try (var fixture = new Fixture()) {
            fixture.hostWithHistory(4);
            var old = new Peer();
            old.pauseReplay = true;
            fixture.join("alice", old);

            var replacement = fixture.join("alice");
            old.drainReplay();
            old.session.disconnect();

            assertThat(old.closed).isTrue();
            assertThat(old.replayRequests).isEqualTo(1);
            assertThat(replacement.closed).isFalse();
            assertThat(replacement.frames).hasSize(4);
        }
    }

    @Test
    void resyncForAPendingTerminalUsesItsScheduledHistoryOnce() {
        try (var fixture = new Fixture()) {
            fixture.hostWithHistory(2);
            var newcomer = new Peer();
            newcomer.pauseReplay = true;
            fixture.join("newcomer", newcomer);

            newcomer.session.handle(new ParticipantCommand.ResyncOutput(2));
            newcomer.drainReplay();
            newcomer.drainReplay();

            assertThat(newcomer.closed).isFalse();
            assertThat(newcomer.replayRequests).isEqualTo(2);
            assertThat(newcomer.messages)
                    .filteredOn(Sync.class::isInstance)
                    .containsExactly(new Sync(1, 1), new Sync(2, 1));
        }
    }

    @Test
    void laterReplayFailureClosesOnlyTheRecoveringParticipant() {
        try (var fixture = new Fixture()) {
            fixture.hostWithHistory(4);
            var newcomer = new Peer();
            newcomer.pauseReplay = true;
            fixture.join("newcomer", newcomer);
            var observer = fixture.join("observer");

            newcomer.acceptingOutput = false;
            newcomer.drainReplay();
            observer.session.handle(new ParticipantCommand.AcquireLease(999));

            assertThat(newcomer.closed).isTrue();
            assertThat(newcomer.frames).hasSize(1);
            assertThat(observer.closed).isFalse();
            assertThat(observer.messages.getLast()).isInstanceOf(LeaseInvalid.class);
            assertThat(fixture.expiry.callbacks).hasSize(1);
        }
    }

    @Test
    void disconnectCancelsHistoriesNotYetReserved() {
        try (var fixture = new Fixture()) {
            fixture.hostWithHistory(4);
            var newcomer = new Peer();
            newcomer.pauseReplay = true;
            fixture.join("newcomer", newcomer);

            newcomer.session.disconnect();
            newcomer.drainReplay();

            assertThat(newcomer.replayRequests).isEqualTo(1);
            assertThat(newcomer.replayCompletions).isEmpty();
        }
    }

    @Test
    void failedObserverDoesNotAbortAnotherParticipantsAdmission() {
        try (var fixture = new Fixture()) {
            var alice = fixture.join("alice");
            alice.sendFailure = new RoomSessions.PeerUnavailable("transport unavailable");

            var bob = fixture.join("bob");

            assertThat(alice.closed).isTrue();
            assertThat(bob.messages.getFirst()).isInstanceOf(Welcome.class);
        }
    }

    @Test
    void failedWelcomeDoesNotLeaveAnUnregisteredParticipantInTheSnapshot() {
        try (var fixture = new Fixture()) {
            var failed = Peer.unavailable();

            fixture.join("failed", failed);
            var observer = fixture.join("observer");

            assertParticipants(observer, "observer");
            assertThat(failed.closed).isTrue();
        }
    }

    @Test
    void unexpectedSendBugsAreReportedAfterRollingBackTheAdmission() {
        try (var fixture = new Fixture()) {
            var broken = new Peer();
            broken.sendFailure = new NullPointerException("serialization bug");

            var failure = catchThrowable(() -> fixture.join("broken", broken));
            var observer = fixture.join("observer");

            assertThat(failure).isSameAs(broken.sendFailure);
            assertParticipants(observer, "observer");
            assertThat(broken.closed).isTrue();
        }
    }

    @Test
    void unexpectedBroadcastBugsStillScheduleCleanupForTheInterruptedAdmission() {
        try (var fixture = new Fixture()) {
            var alice = fixture.join("alice");
            alice.sendFailure = new NullPointerException("event serialization bug");
            var bob = new Peer();

            var failure = catchThrowable(() -> fixture.join("bob", bob));
            alice.sendFailure = null;
            fixture.expiry.callbacks.getFirst().run();
            var observer = fixture.join("observer");

            assertThat(failure).isInstanceOf(NullPointerException.class);
            assertThat(bob.closed).isTrue();
            assertParticipants(observer, "alice", "observer");
        }
    }

    @Test
    void theLastExpiredMemberInvalidatesTheRoomAndItsInvitation() {
        try (var fixture = new Fixture()) {
            var alice = fixture.join("alice");

            alice.disconnect.run();
            fixture.expiry.callbacks.getFirst().run();
            var late = fixture.join("late");

            assertThat(fixture.invitationIsValid()).isFalse();
            assertThat(late.messages.getFirst())
                    .isEqualTo(new Rejected("room-not-found", "room-not-found"));
            assertThat(late.closed).isTrue();
        }
    }

    @Test
    void reconnectCancelsExpiryAndEvenAnAlreadyRunningOldCallbackCannotDeleteTheReplacement() {
        try (var fixture = new Fixture()) {
            var old = fixture.join("alice");
            old.disconnect.run();
            var oldExpiry = fixture.expiry.callbacks.getFirst();

            var current = fixture.join("alice");
            oldExpiry.run();
            old.disconnect.run();
            fixture.join("bob");

            assertThat(fixture.invitationIsValid()).isTrue();
            assertParticipants(current, "alice");
            assertParticipantJoined(current, "bob");
            verify(fixture.expiry.cancellations.getFirst()).cancel();
            assertThat(fixture.expiry.callbacks).hasSize(1);
        }
    }

    @Test
    void anExpiredMemberDoesNotDeleteTheRoomWhileAnotherMemberRemains() {
        try (var fixture = new Fixture()) {
            var alice = fixture.join("alice");
            var observer = fixture.join("observer");

            alice.disconnect.run();
            fixture.expiry.callbacks.getFirst().run();

            assertThat(fixture.invitationIsValid()).isTrue();
            assertThat(observer.messages.getLast()).isEqualTo(new ParticipantLeft("alice"));
        }
    }

    @Test
    void failedReplacementLeavesThePreviousConnectionUsable() {
        try (var fixture = new Fixture()) {
            var current = fixture.join("alice");
            var replacement = Peer.unavailable();

            fixture.join("alice", replacement);
            fixture.join("bob");

            assertThat(current.closed).isFalse();
            assertThat(current.messages).hasSize(2);
            assertThat(replacement.closed).isTrue();
        }
    }

    @Test
    void inventoryRecoversTerminalsWithoutUsingTheReportedSequenceAsAcknowledgement() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");

            host.session.handle(
                    new HostCommand.Inventory(
                            List.of(new HostCommand.Runtime(7, "runtime-7", 0, 999))));
            var observer = fixture.join("observer");

            assertThat(host.messages.getLast())
                    .isEqualTo(new HostReady(List.of(new ReplayPosition(7, 0))));
            assertThat(observer.messages.getFirst())
                    .isInstanceOfSatisfying(
                            Welcome.class,
                            welcome ->
                                    assertThat(welcome.terminals())
                                            .extracting(
                                                    dev.ttyroom.domain.TerminalWorkspace.Terminal
                                                            ::terminalId)
                                            .containsExactly(7L));
        }
    }

    @Test
    void commandsAndDisconnectFromAReplacedHostCannotChangeTheNewSession() {
        try (var fixture = new Fixture()) {
            var old = fixture.joinHost("host");
            var current = fixture.joinHost("host");
            current.session.handle(new HostCommand.Inventory(List.of()));
            current.session.handle(new HostCommand.InputState(true));

            old.session.handle(new HostCommand.InputState(false));
            old.session.handle(new HostCommand.Inventory(List.of()));
            old.disconnect.run();
            var observer = fixture.join("observer");

            assertThat(old.closed).isTrue();
            assertHosts(observer, new HostPresence.State("host", "host", true, true));
            assertThat(fixture.expiry.callbacks).isEmpty();
        }
    }

    @Test
    void aFailedReplacementKeepsThePreviousHostsRecoveryAndInputState() {
        try (var fixture = new Fixture()) {
            var current = fixture.joinHost("host");
            current.session.handle(new HostCommand.Inventory(List.of()));
            current.session.handle(new HostCommand.InputState(true));

            fixture.joinHost("host", Peer.unavailable());
            var observer = fixture.join("observer");

            assertThat(current.closed).isFalse();
            assertHosts(observer, new HostPresence.State("host", "host", true, true));
        }
    }

    @Test
    void aFailedReadyReplyDisconnectsTheHostAndSchedulesItsExpiry() {
        try (var fixture = new Fixture()) {
            var observer = fixture.join("observer");
            var host = fixture.joinHost("host");
            host.sendFailure = new RoomSessions.PeerUnavailable("write failed");

            host.session.handle(new HostCommand.Inventory(List.of()));
            fixture.expiry.callbacks.getFirst().run();

            assertThat(host.closed).isTrue();
            assertThat(observer.messages.subList(1, observer.messages.size()))
                    .containsExactly(
                            new HostConnected(new HostPresence.State("host", "host", true, false)),
                            new HostOffline("host"),
                            new HostRemoved("host"));
        }
    }

    @Test
    void replacedHostCannotInjectOutputOrAdvanceTheRecoveryWatermark() {
        try (var fixture = new Fixture()) {
            var old = fixture.joinHost("host");
            old.recoverTerminal();
            var current = fixture.joinHost("host");
            current.recoverTerminal();
            var observer = fixture.join("observer");

            old.session.output(new OutputFrame(7, 99, new byte[] {9}));
            old.session.handle(new HostCommand.ReplayComplete(7, 99));
            current.session.output(new OutputFrame(7, 1, new byte[] {1}));
            current.recoverTerminal();

            assertThat(observer.frames).hasSize(1);
            assertThat(observer.frames.getFirst().payload()).containsExactly((byte) 1);
            assertThat(current.messages.getLast())
                    .isEqualTo(new HostReady(List.of(new ReplayPosition(7, 1))));
        }
    }

    @Test
    void hostExpiryRemovesItsTerminalHistoryBeforeTheSameIdCanBeRecoveredAgain() {
        try (var fixture = new Fixture()) {
            var observer = fixture.join("observer");
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            host.session.output(new OutputFrame(7, 40, new byte[] {4}));

            host.disconnect.run();
            fixture.expiry.callbacks.getFirst().run();
            var replacement = fixture.joinHost("host");
            replacement.recoverTerminal();
            replacement.session.output(new OutputFrame(7, 1, new byte[] {1}));
            var late = fixture.join("late");

            assertThat(observer.messages).contains(new HostRemoved("host"));
            assertThat(replacement.messages.getLast())
                    .isEqualTo(new HostReady(List.of(new ReplayPosition(7, 0))));
            assertThat(late.frames).hasSize(1);
            assertThat(late.frames.getFirst().payload()).containsExactly((byte) 1);
            assertThat(late.frames.getFirst().seq()).isEqualTo(1);
        }
    }

    @Test
    void replayBackpressureClosesOnlyTheJoiningParticipantAndSchedulesCleanup() {
        try (var fixture = new Fixture()) {
            var observer = fixture.join("observer");
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            host.session.output(new OutputFrame(7, 1, new byte[] {1}));
            var slow = new Peer();
            slow.acceptingOutput = false;

            fixture.join("slow", slow);
            fixture.expiry.callbacks.getFirst().run();
            var late = fixture.join("late");

            assertThat(slow.closed).isTrue();
            assertThat(slow.session).isNull();
            assertThat(slow.messages).noneMatch(Sync.class::isInstance);
            assertThat(observer.messages).contains(new ParticipantLeft("slow"));
            assertParticipants(late, "observer", "late");
            assertThat(late.frames).hasSize(1);
        }
    }

    @Test
    void failedReadyStillPublishesTheCommittedInventoryToExistingParticipants() {
        try (var fixture = new Fixture()) {
            var observer = fixture.join("observer");
            var host = fixture.joinHost("host");
            host.sendFailure = new RoomSessions.PeerUnavailable("write failed");

            host.recoverTerminal();

            assertOpenedTerminal(observer, 7);
            assertThat(observer.messages.getLast()).isEqualTo(new HostOffline("host"));
            assertThat(host.closed).isTrue();
        }
    }

    @Test
    void staleParticipantRequestsAndHostConfirmationsCannotActThroughReplacementSessions() {
        try (var fixture = new Fixture()) {
            var oldParticipant = fixture.join("alice");
            var oldHost = fixture.joinHost("host");
            oldParticipant.session.handle(new ParticipantCommand.OpenTerminal("host"));
            var currentParticipant = fixture.join("alice");
            var currentHost = fixture.joinHost("host");

            oldParticipant.session.handle(new ParticipantCommand.OpenTerminal("host"));
            oldHost.session.handle(new HostCommand.TerminalOpened(1, "stale"));
            oldHost.session.handle(new HostCommand.TerminalClosed(1, null));
            currentHost.session.handle(new HostCommand.TerminalOpened(1, "current"));
            currentParticipant.session.handle(new ParticipantCommand.OpenTerminal("host"));

            assertThat(currentHost.messages)
                    .filteredOn(OpenTerminal.class::isInstance)
                    .containsExactly(new OpenTerminal(2));
            assertThat(currentParticipant.messages)
                    .filteredOn(TerminalOpened.class::isInstance)
                    .hasSize(1);
            assertThat(oldParticipant.closed).isTrue();
            assertThat(oldHost.closed).isTrue();
        }
    }

    @Test
    void replacedHostMetadataCannotOverwriteTheCurrentSessionsReport() {
        try (var fixture = new Fixture()) {
            var old = fixture.joinHost("host");
            old.recoverTerminal();
            var current = fixture.joinHost("host");
            current.recoverTerminal();
            var observer = fixture.join("observer");
            var metadata = new TerminalWorkspace.Metadata("/current", null, "sh");

            current.session.handle(new HostCommand.TerminalMetadata(7, metadata));
            old.session.handle(
                    new HostCommand.TerminalMetadata(
                            7, new TerminalWorkspace.Metadata("/stale", null, null)));
            var late = fixture.join("late");

            assertThat(observer.messages)
                    .filteredOn(TerminalMetadataChanged.class::isInstance)
                    .containsExactly(new TerminalMetadataChanged(7, metadata));
            assertThat(((Welcome) late.messages.getFirst()).terminals().getFirst().meta())
                    .isEqualTo(metadata);
        }
    }

    @ParameterizedTest
    @MethodSource("terminalReports")
    void failedOwnershipRejectionClosesOnlyTheReportingHost(HostCommand report) {
        try (var fixture = new Fixture()) {
            var owner = fixture.joinHost("owner");
            owner.recoverTerminal();
            var observer = fixture.join("observer");
            var intruder = fixture.joinHost("intruder");
            intruder.sendFailure = new RoomSessions.PeerUnavailable("rejection cannot be sent");

            intruder.session.handle(report);
            var late = fixture.join("late");

            assertThat(intruder.closed).isTrue();
            assertThat(owner.closed).isFalse();
            assertThat(observer.closed).isFalse();
            assertThat(observer.messages).contains(new HostOffline("intruder"));
            assertThat(((Welcome) late.messages.getFirst()).terminals())
                    .isEqualTo(((Welcome) observer.messages.getFirst()).terminals());
        }
    }

    static Stream<HostCommand> terminalReports() {
        return Stream.of(
                new HostCommand.TerminalOpened(7, "foreign"),
                new HostCommand.TerminalClosed(7, 9.0),
                new HostCommand.TerminalMetadata(
                        7, new TerminalWorkspace.Metadata("/foreign", null, null)));
    }

    @Test
    void unexpectedRejectionSerializationBugsAreNotTreatedAsTransportFailures() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.sendFailure = new NullPointerException("serialization bug");

            var failure =
                    catchThrowable(
                            () ->
                                    host.session.handle(
                                            new HostCommand.TerminalMetadata(
                                                    99,
                                                    new TerminalWorkspace.Metadata(
                                                            null, null, null))));

            assertThat(failure).isSameAs(host.sendFailure);
            assertThat(host.closed).isFalse();
        }
    }

    @Test
    void hostSendFailurePreservesTheReservationAndClosesOnlyThatHost() {
        try (var fixture = new Fixture()) {
            var participant = fixture.join("alice");
            var host = fixture.joinHost("host");
            host.sendFailure = new RoomSessions.PeerUnavailable("cannot send open");

            participant.session.handle(new ParticipantCommand.OpenTerminal("host"));
            var replacement = fixture.joinHost("host");
            replacement.session.handle(new HostCommand.Inventory(List.of()));
            participant.session.handle(new ParticipantCommand.OpenTerminal("host"));

            assertThat(host.closed).isTrue();
            assertThat(participant.closed).isFalse();
            assertThat(participant.messages)
                    .contains(
                            new Rejected("bad-message", "host is unavailable"),
                            new TerminalClosed(1));
            assertThat(participant.messages).noneMatch(TerminalOpened.class::isInstance);
            assertThat(replacement.messages.getLast()).isEqualTo(new OpenTerminal(2));
        }
    }

    @Test
    void concurrentParticipantRequestsShareOneRoomIdAllocator() throws Exception {
        try (var fixture = new Fixture();
                var clients = Executors.newVirtualThreadPerTaskExecutor()) {
            var alice = fixture.join("alice");
            var bob = fixture.join("bob");
            var host = fixture.joinHost("host");
            var start = new CountDownLatch(1);
            var first =
                    clients.submit(
                            () -> {
                                start.await();
                                alice.session.handle(new ParticipantCommand.OpenTerminal("host"));
                                return null;
                            });
            var second =
                    clients.submit(
                            () -> {
                                start.await();
                                bob.session.handle(new ParticipantCommand.OpenTerminal("host"));
                                return null;
                            });

            start.countDown();
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);

            assertThat(host.messages)
                    .filteredOn(OpenTerminal.class::isInstance)
                    .containsExactly(new OpenTerminal(1), new OpenTerminal(2));
        }
    }

    private static void assertHosts(Peer peer, HostPresence.State... hosts) {
        assertThat(peer.messages.getFirst())
                .isInstanceOfSatisfying(
                        Welcome.class,
                        welcome -> assertThat(welcome.hosts()).containsExactly(hosts));
    }

    private static void assertOpenedTerminal(Peer peer, long terminalId) {
        var openedIds =
                peer.messages.stream()
                        .filter(TerminalOpened.class::isInstance)
                        .map(TerminalOpened.class::cast)
                        .map(opened -> opened.terminal().terminalId())
                        .toList();
        assertThat(openedIds).contains(terminalId);
    }

    private static void assertParticipants(Peer peer, String... expectedIds) {
        assertThat(peer.messages.getFirst())
                .isInstanceOfSatisfying(
                        Welcome.class,
                        welcome ->
                                assertThat(welcome.participants())
                                        .extracting(Participant::clientId)
                                        .containsExactly(expectedIds));
    }

    private static void assertParticipantJoined(Peer peer, String clientId) {
        assertThat(peer.messages.getLast())
                .isEqualTo(new ParticipantJoined(new Participant(clientId, clientId, null)));
    }

    @Test
    void replacedParticipantCannotSendOrReleaseTheLeaseOfItsCurrentSession() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            host.session.handle(new HostCommand.InputState(true));
            host.acceptingInput = true;
            var old = fixture.join("alice");
            old.session.handle(new ParticipantCommand.AcquireLease(7));
            var current = fixture.join("alice");

            old.session.input(input());
            old.session.handle(new ParticipantCommand.ReleaseLease(7, 1));
            current.session.input(input());

            assertThat(host.inputs).hasSize(1);
            assertThat(((Welcome) current.messages.getFirst()).leases())
                    .containsExactly(new LeaseControl.Lease(7, 1, "alice"));
            assertThat(current.messages).noneMatch(LeaseInvalid.class::isInstance);
        }
    }

    @Test
    void participantGraceKeepsTheLeaseUntilExpiryThenReleasesBeforeDeparture() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            var bob = fixture.join("bob");

            alice.session.disconnect();
            bob.session.handle(new ParticipantCommand.AcquireLease(7));
            fixture.expiry.callbacks.getFirst().run();
            bob.session.handle(new ParticipantCommand.AcquireLease(7));

            assertThat(bob.messages.subList(2, bob.messages.size()))
                    .containsExactly(
                            new LeaseDenied(7, "alice"),
                            new LeaseReleased(7),
                            new ParticipantLeft("alice"),
                            new LeaseAccepted(7, 2),
                            new LeaseGranted(new LeaseControl.Lease(7, 2, "bob")));
        }
    }

    @Test
    void cancelledParticipantExpiryCannotReleaseTheReconnectedLease() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            alice.session.disconnect();
            var staleExpiry = fixture.expiry.callbacks.getFirst();
            var current = fixture.join("alice");

            staleExpiry.run();
            current.session.handle(new ParticipantCommand.AcquireLease(7));

            assertThat(current.messages.getLast()).isEqualTo(new LeaseAccepted(7, 1));
        }
    }

    @Test
    void hostExpiryRemovesItsLeaseAndDoesNotRewindTheAllocator() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));

            host.session.disconnect();
            fixture.expiry.callbacks.getFirst().run();
            var afterExpiry = fixture.join("late");
            var replacement = fixture.joinHost("host");
            replacement.recoverTerminal();
            alice.session.handle(new ParticipantCommand.AcquireLease(7));

            assertThat(((Welcome) afterExpiry.messages.getFirst()).leases()).isEmpty();
            assertThat(alice.messages).contains(new LeaseAccepted(7, 2));
        }
    }

    @Test
    void failedAcquisitionReplyStillPublishesTheCommittedLeaseAndKeepsItsGrace() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var observer = fixture.join("observer");
            var alice = fixture.join("alice");
            alice.sendFailure = new RoomSessions.PeerUnavailable("reply queue full");

            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            var late = fixture.join("late");

            assertThat(alice.closed).isTrue();
            assertThat(observer.messages)
                    .contains(new LeaseGranted(new LeaseControl.Lease(7, 1, "alice")));
            assertThat(((Welcome) late.messages.getFirst()).leases())
                    .containsExactly(new LeaseControl.Lease(7, 1, "alice"));
        }
    }

    @Test
    void failedInputDeliveryClosesOnlyTheHostAndDoesNotRetryTheCommand() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            host.session.handle(new HostCommand.InputState(true));
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            host.sendFailure = new RoomSessions.PeerUnavailable("input queue full");

            alice.session.input(input());
            alice.session.input(input());

            assertThat(host.closed).isTrue();
            assertThat(alice.closed).isFalse();
            assertThat(host.inputs).isEmpty();
            assertThat(host.inputAttempts).isEqualTo(1);
            assertThat(alice.messages)
                    .filteredOn(LeaseInvalid.class::isInstance)
                    .containsExactly(
                            new LeaseInvalid(7, InputRejection.TERMINAL_CLOSED),
                            new LeaseInvalid(7, InputRejection.TERMINAL_CLOSED));
        }
    }

    @Test
    void simultaneousAcquisitionHasExactlyOneWinner() throws Exception {
        try (var fixture = new Fixture();
                var clients = Executors.newVirtualThreadPerTaskExecutor()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            var bob = fixture.join("bob");
            var start = new CountDownLatch(1);
            var first =
                    clients.submit(
                            () -> {
                                start.await();
                                alice.session.handle(new ParticipantCommand.AcquireLease(7));
                                return null;
                            });
            var second =
                    clients.submit(
                            () -> {
                                start.await();
                                bob.session.handle(new ParticipantCommand.AcquireLease(7));
                                return null;
                            });

            start.countDown();
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);
            var late = fixture.join("late");

            var replies = Stream.concat(alice.messages.stream(), bob.messages.stream()).toList();
            assertThat(replies).filteredOn(LeaseAccepted.class::isInstance).hasSize(1);
            assertThat(replies).filteredOn(LeaseDenied.class::isInstance).hasSize(1);
            assertThat(((Welcome) late.messages.getFirst()).leases()).hasSize(1);
        }
    }

    @Test
    void replacedParticipantCannotChangeModeThroughItsOldSession() {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var old = fixture.join("alice");
            var current = fixture.join("alice");

            old.session.handle(
                    new ParticipantCommand.SetTerminalMode(7, TerminalWorkspace.Mode.SHARED));
            var late = fixture.join("late");

            assertThat(((Welcome) late.messages.getFirst()).terminals().getFirst().mode())
                    .isEqualTo(TerminalWorkspace.Mode.EXCLUSIVE);
            assertThat(current.messages).noneMatch(TerminalModeChanged.class::isInstance);
        }
    }

    @Test
    void failedModeBroadcastIsolatesThePeerAndPreservesCommittedStateAndLease() {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            var bob = fixture.join("bob");
            alice.sendFailure = new RoomSessions.PeerUnavailable("cannot receive mode");

            alice.session.handle(
                    new ParticipantCommand.SetTerminalMode(7, TerminalWorkspace.Mode.SHARED));
            var late = fixture.join("late");

            assertThat(alice.closed).isTrue();
            assertThat(bob.closed).isFalse();
            assertThat(bob.messages)
                    .contains(new TerminalModeChanged(7, TerminalWorkspace.Mode.SHARED));
            var welcome = (Welcome) late.messages.getFirst();
            assertThat(welcome.terminals().getFirst().mode())
                    .isEqualTo(TerminalWorkspace.Mode.SHARED);
            assertThat(welcome.leases()).containsExactly(new LeaseControl.Lease(7, 1, "alice"));
        }
    }

    @Test
    void participantExpiryDuringSharedDoesNotResurrectLeaseOnExclusiveReturn() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            host.session.handle(new HostCommand.InputState(true));
            var alice = fixture.join("alice");
            var bob = fixture.join("bob");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            bob.session.handle(
                    new ParticipantCommand.SetTerminalMode(7, TerminalWorkspace.Mode.SHARED));
            alice.session.disconnect();

            fixture.expiry.callbacks.getLast().run();
            bob.session.handle(
                    new ParticipantCommand.SetTerminalMode(7, TerminalWorkspace.Mode.EXCLUSIVE));
            bob.session.input(input());
            var late = fixture.join("late");

            assertThat(((Welcome) late.messages.getFirst()).leases()).isEmpty();
            assertThat(bob.messages)
                    .contains(new LeaseReleased(7), new LeaseInvalid(7, InputRejection.NOT_HOLDER));
            assertThat(host.inputs).isEmpty();
        }
    }

    @ParameterizedTest
    @MethodSource("terminalControls")
    void replacedParticipantCannotForwardTerminalControls(ParticipantCommand command) {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var old = fixture.join("alice");
            fixture.join("alice");
            var before = List.copyOf(host.messages);

            old.session.handle(command);

            assertThat(host.messages).isEqualTo(before);
        }
    }

    @ParameterizedTest
    @MethodSource("terminalControls")
    void failedTerminalControlKeepsStateAndLeaseAndDoesNotRetry(ParticipantCommand command) {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            var before = (Welcome) fixture.join("before").messages.getFirst();
            var attempts = host.sendAttempts;
            host.sendFailure = new RoomSessions.PeerUnavailable("queue rejected");

            alice.session.handle(command);
            alice.session.handle(command);
            var after = (Welcome) fixture.join("after").messages.getFirst();

            assertThat(host.closed).isTrue();
            assertThat(alice.closed).isFalse();
            assertThat(host.sendAttempts).isEqualTo(attempts + 1);
            assertThat(after.terminals()).isEqualTo(before.terminals());
            assertThat(after.leases()).isEqualTo(before.leases());
            var expected =
                    switch (command) {
                        case ParticipantCommand.CloseTerminal close ->
                                new TerminalCloseRejected(
                                        7,
                                        dev.ttyroom.domain.RoomControl.TerminalRejection
                                                .HOST_OFFLINE);
                        case ParticipantCommand.ResizeTerminal resize ->
                                new Rejected("bad-message", "host is unavailable");
                        default -> throw new AssertionError("Unexpected test command");
                    };
            assertThat(alice.messages).contains(expected);
        }
    }

    @ParameterizedTest
    @MethodSource("terminalControls")
    void terminalControlProgrammingErrorsAreNotSilencedAsTransportFailures(
            ParticipantCommand command) {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            host.sendFailure = new IllegalStateException("encoding bug");

            var failure = catchThrowable(() -> alice.session.handle(command));

            assertThat(failure).isSameAs(host.sendFailure);
            assertThat(host.closed).isFalse();
            assertThat(alice.closed).isFalse();
        }
    }

    static Stream<ParticipantCommand> terminalControls() {
        return Stream.of(
                new ParticipantCommand.CloseTerminal(7),
                new ParticipantCommand.ResizeTerminal(7, 120, 40));
    }

    @ParameterizedTest
    @MethodSource("terminalViewEdits")
    void replacedParticipantCannotEditViewThroughAnOldSession(ParticipantCommand command) {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var old = fixture.join("alice");
            var before = ((Welcome) old.messages.getFirst()).terminals();
            var current = fixture.join("alice");

            old.session.handle(command);
            var after = (Welcome) fixture.join("late").messages.getFirst();

            assertThat(after.terminals()).isEqualTo(before);
            assertThat(current.messages)
                    .noneMatch(
                            m ->
                                    m instanceof TerminalRenamed
                                            || m instanceof TerminalGeometryChanged);
        }
    }

    @ParameterizedTest
    @MethodSource("terminalViewEdits")
    void failedViewBroadcastPreservesStateAndLeaseAndDoesNotSendPtyCommands(
            ParticipantCommand command) {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            var bob = fixture.join("bob");
            var hostMessages = List.copyOf(host.messages);
            alice.sendFailure = new RoomSessions.PeerUnavailable("cannot receive view");

            alice.session.handle(command);
            var welcome = (Welcome) fixture.join("late").messages.getFirst();
            var terminal = welcome.terminals().getFirst();
            RoomNotice expected =
                    switch (command) {
                        case ParticipantCommand.RenameTerminal rename ->
                                new TerminalRenamed(7, rename.title());
                        case ParticipantCommand.UpdateTerminalGeometry move ->
                                new TerminalGeometryChanged(7, move.geometry());
                        default -> throw new AssertionError("Unexpected view fixture");
                    };

            assertThat(alice.closed).isTrue();
            assertThat(bob.closed).isFalse();
            assertThat(bob.messages).contains(expected);
            assertThat(host.messages).isEqualTo(hostMessages);
            assertThat(welcome.leases()).containsExactly(new LeaseControl.Lease(7, 1, "alice"));
            switch (command) {
                case ParticipantCommand.RenameTerminal rename ->
                        assertThat(terminal.title()).isEqualTo(rename.title());
                case ParticipantCommand.UpdateTerminalGeometry move ->
                        assertThat(terminal.geometry()).isEqualTo(move.geometry());
                default -> throw new AssertionError("Unexpected view fixture");
            }
        }
    }

    @ParameterizedTest
    @MethodSource("terminalViewEdits")
    void unexpectedViewBroadcastFailureIsNotHidden(ParticipantCommand command) {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var alice = fixture.join("alice");
            alice.sendFailure = new IllegalStateException("encoder bug");

            var failure = catchThrowable(() -> alice.session.handle(command));

            assertThat(failure).isSameAs(alice.sendFailure);
            assertThat(alice.closed).isFalse();
        }
    }

    static Stream<ParticipantCommand> terminalViewEdits() {
        return Stream.of(
                new ParticipantCommand.RenameTerminal(7, "API"),
                new ParticipantCommand.UpdateTerminalGeometry(
                        7, new TerminalWorkspace.Geometry(-1.5, 2.5, 600, 400)));
    }

    @Test
    void failedParticipantReplacementPreservesFocusLeaseAndEarlierSnapshots() {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var alice = fixture.join("alice");
            var initial = (Welcome) alice.messages.getFirst();
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            alice.session.handle(new ParticipantCommand.FocusTerminal(7L));
            var failed = Peer.unavailable();

            fixture.join("alice", failed);
            var afterFailure = (Welcome) fixture.join("observer").messages.getFirst();
            alice.session.handle(new ParticipantCommand.FocusTerminal(null));
            var afterBlur = (Welcome) fixture.join("late").messages.getFirst();

            assertThat(failed.closed).isTrue();
            assertThat(alice.closed).isFalse();
            assertThat(initial.participants())
                    .containsExactly(new Participant("alice", "alice", null));
            assertThat(afterFailure.participants()).contains(new Participant("alice", "alice", 7L));
            assertThat(afterFailure.leases())
                    .containsExactly(new LeaseControl.Lease(7, 1, "alice"));
            assertThat(afterBlur.participants()).contains(new Participant("alice", "alice", null));
        }
    }

    @Test
    void graceKeepsFocusButParticipantExpiryClearsItTogetherWithTheLease() {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            alice.session.handle(new ParticipantCommand.FocusTerminal(7L));

            alice.session.disconnect();
            var duringGrace = (Welcome) fixture.join("observer").messages.getFirst();
            fixture.expiry.callbacks.getFirst().run();
            var rejoined = (Welcome) fixture.join("alice").messages.getFirst();

            assertThat(duringGrace.participants()).contains(new Participant("alice", "alice", 7L));
            assertThat(rejoined.participants()).contains(new Participant("alice", "alice", null));
            assertThat(rejoined.leases()).isEmpty();
        }
    }

    @Test
    void staleSessionAndExpiryCannotChangeAReplacementParticipantsFocusOrShareCursor() {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var old = fixture.join("alice");
            old.session.handle(new ParticipantCommand.FocusTerminal(7L));
            var bob = fixture.join("bob");
            old.session.disconnect();
            var expiry = fixture.expiry.callbacks.getFirst();
            var current = fixture.join("alice");
            var before = List.copyOf(bob.messages);

            old.session.handle(new ParticipantCommand.FocusTerminal(null));
            old.session.handle(new ParticipantCommand.MoveCursor(new CursorPosition(1, 2)));
            old.session.disconnect();
            expiry.run();
            var after = List.copyOf(bob.messages);
            var welcome = (Welcome) fixture.join("late").messages.getFirst();

            assertThat(current.closed).isFalse();
            assertThat(after).isEqualTo(before);
            assertThat(welcome.participants()).contains(new Participant("alice", "alice", 7L));
        }
    }

    @Test
    void hostExpiryKeepsTheFocusReferenceButRejectsRefocusingTheRemovedTerminalBeforeEquality() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.FocusTerminal(7L));

            host.session.disconnect();
            fixture.expiry.callbacks.getFirst().run();
            var afterRemoval = (Welcome) fixture.join("observer").messages.getFirst();
            alice.session.handle(new ParticipantCommand.FocusTerminal(7L));
            var rejected = alice.messages.getLast();
            alice.session.handle(new ParticipantCommand.FocusTerminal(null));

            assertThat(afterRemoval.terminals()).isEmpty();
            assertThat(afterRemoval.participants()).contains(new Participant("alice", "alice", 7L));
            assertThat(rejected)
                    .isInstanceOfSatisfying(
                            Rejected.class,
                            error -> assertThat(error.code()).isEqualTo("bad-message"));
            assertThat(alice.messages.getLast())
                    .isEqualTo(new ParticipantFocusChanged("alice", null));
        }
    }

    @Test
    void failedFocusBroadcastPreservesCommittedFocusAndLeaseWhileOtherPeersReceiveIt() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            var bob = fixture.join("bob");
            var hostMessages = List.copyOf(host.messages);
            alice.sendFailure = new RoomSessions.PeerUnavailable("cannot receive focus");

            alice.session.handle(new ParticipantCommand.FocusTerminal(7L));
            var welcome = (Welcome) fixture.join("late").messages.getFirst();

            assertThat(alice.closed).isTrue();
            assertThat(bob.closed).isFalse();
            assertThat(bob.messages).contains(new ParticipantFocusChanged("alice", 7L));
            assertThat(host.messages).isEqualTo(hostMessages);
            assertThat(welcome.participants()).contains(new Participant("alice", "alice", 7L));
            assertThat(welcome.leases()).containsExactly(new LeaseControl.Lease(7, 1, "alice"));
        }
    }

    @Test
    void cursorBroadcastFailureIsolatesOnlyTheFailedRecipientAndDoesNotReachHostOrSender() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var alice = fixture.join("alice");
            var failed = fixture.join("failed");
            var bob = fixture.join("bob");
            var senderMessages = List.copyOf(alice.messages);
            var hostMessages = List.copyOf(host.messages);
            failed.sendFailure = new RoomSessions.PeerUnavailable("cannot receive cursor");
            var position = new CursorPosition(1.5, -2.5);

            alice.session.handle(new ParticipantCommand.MoveCursor(position));
            alice.session.handle(new ParticipantCommand.MoveCursor(null));

            assertThat(failed.closed).isTrue();
            assertThat(alice.closed).isFalse();
            assertThat(bob.closed).isFalse();
            assertThat(bob.messages)
                    .contains(
                            new ParticipantCursor("alice", position),
                            new ParticipantCursor("alice", null));
            assertThat(alice.messages).isEqualTo(senderMessages);
            assertThat(host.messages).isEqualTo(hostMessages);
        }
    }

    @ParameterizedTest
    @MethodSource("participantPresenceCommands")
    void unexpectedPresenceBroadcastErrorsAreNotHidden(ParticipantCommand command) {
        try (var fixture = new Fixture()) {
            fixture.joinHost("host").recoverTerminal();
            var alice = fixture.join("alice");
            var bob = fixture.join("bob");
            bob.sendFailure = new IllegalStateException("encoder bug");

            var failure = catchThrowable(() -> alice.session.handle(command));

            assertThat(failure).isSameAs(bob.sendFailure);
            assertThat(alice.closed).isFalse();
        }
    }

    static Stream<ParticipantCommand> participantPresenceCommands() {
        return Stream.of(
                new ParticipantCommand.FocusTerminal(7L),
                new ParticipantCommand.MoveCursor(new CursorPosition(1, 2)));
    }

    @Test
    void restoredDirectoryWelcomesOfflineHostsAndWorkspaceWithoutTheirOldSessions() {
        try (var original = new Fixture()) {
            var host = original.joinHost("host");
            host.recoverTerminal();
            host.session.handle(new HostCommand.InputState(true));
            host.session.output(new OutputFrame(7, 42, new byte[] {65}));
            var alice = original.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            alice.session.handle(new ParticipantCommand.FocusTerminal(7L));
            var before = (Welcome) original.join("observer").messages.getFirst();
            var saved = original.durableState();

            try (var restored = new Fixture(new RoomDirectory(List.of(saved)), original.room)) {
                var rejoined = restored.join("alice");
                var welcome = (Welcome) rejoined.messages.getFirst();
                rejoined.session.input(new InputFrame(7, 1, 1, new byte[] {66}));

                assertThat(welcome.roomId()).isEqualTo(before.roomId());
                assertThat(welcome.roomName()).isEqualTo(before.roomName());
                assertThat(welcome.terminals()).isEqualTo(before.terminals());
                assertThat(welcome.hosts())
                        .containsExactly(new HostPresence.State("host", "host", false, false));
                assertThat(welcome.participants())
                        .containsExactly(new Participant("alice", "alice", null));
                assertThat(welcome.leases()).isEmpty();
                assertThat(rejoined.frames).isEmpty();
                assertThat(rejoined.messages).contains(new Sync(7, 0));
                assertThat(restored.expiry.callbacks).isEmpty();
                assertThat(rejoined.messages.getLast())
                        .isEqualTo(new LeaseInvalid(7, InputRejection.TERMINAL_CLOSED));
            }
        }
    }

    @Test
    void livePresenceAndOutputChangesLeaveTheDurableProjectionUnchanged() {
        try (var fixture = new Fixture()) {
            var host = fixture.joinHost("host");
            host.recoverTerminal();
            var before = fixture.durableState();

            var alice = fixture.join("alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            alice.session.handle(new ParticipantCommand.FocusTerminal(7L));
            alice.session.handle(new ParticipantCommand.MoveCursor(new CursorPosition(1, 2)));
            host.session.handle(new HostCommand.InputState(true));
            host.session.output(new OutputFrame(7, 1, new byte[] {65}));
            alice.session.disconnect();
            host.session.disconnect();
            var after = fixture.durableState();

            assertThat(after).isEqualTo(before);
        }
    }

    @Test
    void failedHostWelcomeKeepsTheCommittedIdentityButDoesNotEraseItsWorkspace() {
        try (var original = new Fixture()) {
            original.joinHost("host").recoverTerminal();
            var saved = original.durableState();
            try (var restored = new Fixture(new RoomDirectory(List.of(saved)), original.room)) {
                var failed = Peer.unavailable();

                restored.admission.join(
                        new RoomSessions.Hello(
                                7,
                                original.room.roomId(),
                                original.room.token(),
                                "host",
                                "Wrong name",
                                RoomSessions.Role.HOST),
                        failed);
                var welcome = (Welcome) restored.join("observer").messages.getFirst();
                var after = restored.durableState();

                assertThat(failed.closed).isTrue();
                assertThat(after.control().workspace()).isEqualTo(saved.control().workspace());
                assertThat(welcome.hosts())
                        .containsExactly(
                                new HostPresence.State("host", "Wrong name", false, false));
                assertThat(welcome.terminals()).hasSize(1);
            }
        }
    }

    @Test
    void restoredHostRejoinsUnderItsOriginalIdentityAndExpiryRemovesItsDurableWorkspace() {
        try (var original = new Fixture()) {
            original.joinHost("host").recoverTerminal();
            var saved = original.durableState();
            try (var restored = new Fixture(new RoomDirectory(List.of(saved)), original.room)) {
                restored.join("observer");

                var host = restored.joinHost("host");
                host.recoverTerminal();
                var recovered = (Welcome) restored.join("late").messages.getFirst();
                host.session.disconnect();
                restored.expiry.callbacks.getFirst().run();
                var afterExpiry = restored.durableState();

                assertThat(recovered.hosts())
                        .containsExactly(new HostPresence.State("host", "host", true, false));
                assertThat(host.messages)
                        .contains(new HostReady(List.of(new ReplayPosition(7, 0))));
                assertThat(afterExpiry.control().hosts()).isEmpty();
                assertThat(afterExpiry.control().workspace().terminals()).isEmpty();
                assertThat(afterExpiry.control().workspace().nextTerminalId()).isEqualTo(8);
            }
        }
    }

    @Test
    void restoredOfflineHostIsNotAConnectedMemberThatPreventsEmptyRoomExpiry() {
        try (var original = new Fixture()) {
            original.joinHost("host").recoverTerminal();
            var saved = original.durableState();
            try (var restored = new Fixture(new RoomDirectory(List.of(saved)), original.room)) {
                var alice = restored.join("alice");

                alice.session.disconnect();
                restored.expiry.callbacks.getFirst().run();

                assertThat(restored.invitationIsValid()).isFalse();
            }
        }
    }

    private static InputFrame input() {
        return new InputFrame(7, 17, 1, new byte[] {65});
    }

    private static final class Fixture implements AutoCloseable {
        final RoomDirectory rooms;
        final RoomDirectory.Invitation room;
        final ManualExpiry expiry = new ManualExpiry();
        final RoomSessions admission;

        Fixture() {
            this(new RoomDirectory(), null);
        }

        Fixture(RoomDirectory rooms, RoomDirectory.Invitation invitation) {
            this.rooms = rooms;
            this.room = invitation == null ? rooms.create("test") : invitation;
            this.admission = new RoomSessions(rooms, expiry.timers);
        }

        RoomDirectory.StoredRoom durableState() {
            return rooms.authenticatedRoom(room.roomId(), room.token()).durableState();
        }

        Peer join(String clientId) {
            return join(clientId, new Peer());
        }

        Peer joinHost(String clientId) {
            return join(clientId, new Peer(), RoomSessions.Role.HOST);
        }

        Peer joinHost(String clientId, Peer peer) {
            return join(clientId, peer, RoomSessions.Role.HOST);
        }

        Peer join(String clientId, Peer peer) {
            return join(clientId, peer, RoomSessions.Role.PARTICIPANT);
        }

        private Peer join(String clientId, Peer peer, RoomSessions.Role role) {
            var session =
                    admission.join(
                            new RoomSessions.Hello(
                                    7, room.roomId(), room.token(), clientId, clientId, role),
                            peer);
            peer.session = session;
            peer.disconnect =
                    () -> {
                        if (session != null) session.disconnect();
                    };
            return peer;
        }

        Peer hostWithHistory(int terminals) {
            var host = joinHost("host");
            host.session.handle(
                    new HostCommand.Inventory(
                            java.util.stream.LongStream.rangeClosed(1, terminals)
                                    .mapToObj(
                                            id ->
                                                    new HostCommand.Runtime(
                                                            id, "runtime-" + id, 0, 0))
                                    .toList()));
            for (long id = 1; id <= terminals; id++)
                host.session.output(new OutputFrame(id, 1, new byte[1_048_576]));
            return host;
        }

        boolean invitationIsValid() {
            return rooms.acceptsToken(room.roomId(), room.token());
        }

        @Override
        public void close() {
            admission.close();
        }
    }

    private static final class Peer implements RoomSessions.Peer {
        final List<RoomNotice> messages = new ArrayList<>();
        final List<OutputFrame> frames = new ArrayList<>();
        final List<InputFrame> inputs = new ArrayList<>();
        boolean pauseReplay;
        final java.util.ArrayDeque<Runnable> replayCompletions = new java.util.ArrayDeque<>();
        int replayRequests;
        boolean acceptingInput;
        int inputAttempts;
        int sendAttempts;
        boolean acceptingOutput = true;
        RuntimeException sendFailure;
        Runnable disconnect;
        RoomSessions.Session session;
        boolean closed;

        void drainReplay() {
            replayCompletions.removeFirst().run();
        }

        void recoverTerminal() {
            session.handle(
                    new HostCommand.Inventory(
                            List.of(new HostCommand.Runtime(7, "runtime-7", 0, 0))));
        }

        static Peer unavailable() {
            var peer = new Peer();
            peer.sendFailure = new RoomSessions.PeerUnavailable("transport unavailable");
            return peer;
        }

        @Override
        public void sendInput(InputFrame frame) {
            inputAttempts++;
            if (sendFailure != null) throw sendFailure;
            if (!acceptingInput) throw new AssertionError("Unexpected Connector input");
            inputs.add(frame);
        }

        @Override
        public void send(RoomNotice message) {
            sendAttempts++;
            if (sendFailure != null) throw sendFailure;
            messages.add(message);
        }

        @Override
        public void replayOutput(
                List<OutputFrame> frames, RoomNotice.Sync boundary, Runnable afterSync) {
            if (pauseReplay && !replayCompletions.isEmpty())
                throw new RoomSessions.PeerUnavailable("Replay still in flight");
            replayRequests++;
            if (!acceptingOutput) throw new RoomSessions.PeerUnavailable("Replay budget exhausted");
            this.frames.addAll(frames);
            messages.add(boundary);
            if (pauseReplay) replayCompletions.addLast(afterSync);
            else afterSync.run();
        }

        public boolean offerOutput(OutputFrame frame, RoomNotice.OutputGap gap) {
            if (!acceptingOutput) return false;
            frames.add(frame);
            return true;
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static final class ManualExpiry {
        final ExpiryTimers timers = mock(ExpiryTimers.class);
        final List<Runnable> callbacks = new ArrayList<>();
        final List<ExpiryTimers.Cancellation> cancellations = new ArrayList<>();

        ManualExpiry() {
            when(timers.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS)))
                    .thenAnswer(
                            call -> {
                                callbacks.add(call.getArgument(0));
                                var cancellation = mock(ExpiryTimers.Cancellation.class);
                                cancellations.add(cancellation);
                                return cancellation;
                            });
        }
    }
}

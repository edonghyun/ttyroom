package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import dev.ttyroom.application.CredentialRoom.GatedStore;
import dev.ttyroom.application.CredentialRoom.Peer;
import dev.ttyroom.application.RoomNotice.*;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

class CredentialRevocationTests {
    @Test
    void revocationPreventsALateSyncFromReservingAnotherTerminalHistory() {
        try (var room = new CredentialRoom()) {
            var host = room.givenConnected(room.host(), "Host");
            host.session.handle(
                    new HostCommand.Inventory(
                            List.of(
                                    new HostCommand.Runtime(1, "one", 0, 0),
                                    new HostCommand.Runtime(2, "two", 0, 0))));
            var credential = room.participant();
            var alice = new Peer();
            alice.pauseReplay = true;
            room.connect(credential.secret(), "Alice", alice);

            room.revoke(credential);
            alice.replayCompletions.removeFirst().run();

            assertThat(alice.closed).isTrue();
            assertThat(alice.notices)
                    .filteredOn(Sync.class::isInstance)
                    .containsExactly(new Sync(1, 0));
            assertThat(alice.replayCompletions).isEmpty();
        }
    }

    @Test
    void revokingAParticipantReleasesItsLeaseAndMakesLateCallbacksAndInputInert() {
        try (var room = new CredentialRoom()) {
            var credential = room.participant();
            var alice = room.givenConnected(credential, "Alice");
            var lease = room.givenTerminalLease(alice);
            var bob = room.givenConnectedParticipant("Bob");
            bob.notices.clear();

            room.revoke(credential);
            alice.session.disconnect();
            alice.session.input(new InputFrame(7, 1, lease.leaseId(), new byte[] {1}));
            alice.session.handle(new ParticipantCommand.MoveCursor(new CursorPosition(1, 2)));
            var removal = List.copyOf(bob.notices);
            bob.session.handle(new ParticipantCommand.AcquireLease(7));
            var rejoining = room.connect(credential, "Rejected");

            assertThat(alice.closed).isTrue();
            assertThat(alice.notices)
                    .contains(new Rejected("invalid-credential", "invalid-credential"));
            assertThat(removal)
                    .containsExactly(
                            new LeaseReleased(7), new ParticipantLeft(credential.subject().id()));
            assertThat(bob.notices).anyMatch(LeaseAccepted.class::isInstance);
            assertThat(room.expiry).isEmpty();
            assertRejected(rejoining);
        }
    }

    @Test
    void hostRevocationSavesItsCredentialAndWorkspaceRemovalOnceBeforeClosingThePeer() {
        var store = new GatedStore();
        try (var room = new CredentialRoom(store)) {
            var credential = room.host();
            var host = room.givenConnected(credential, "Computer");
            host.session.handle(
                    new HostCommand.Inventory(List.of(new HostCommand.Runtime(7, "pty", 0, 0))));
            var observer = room.givenConnectedParticipant("Observer");
            var writesBefore = store.writes;
            observer.notices.clear();

            room.revoke(credential);
            host.session.handle(
                    new HostCommand.Inventory(List.of(new HostCommand.Runtime(8, "late", 0, 0))));
            host.session.output(new OutputFrame(7, 1, new byte[] {1}));
            var writesAfterRevocation = store.writes;
            var snapshot = room.connect(room.participant(), "After").welcome();
            java.util.Optional<RoomCredentials.Subject> restoredAuthority;
            try (var restored = new RoomDirectory(List.of(store.stored))) {
                restoredAuthority =
                        restored.authenticateCredential(
                                restored.roomForAdmission(room.invitation.roomId()),
                                credential.secret());
            }

            assertThat(restoredAuthority).isEmpty();
            assertThat(writesAfterRevocation).isEqualTo(writesBefore + 1);
            assertThat(host.closed).isTrue();
            assertThat(observer.notices).contains(new HostRemoved(credential.subject().id()));
            assertThat(observer.outputs).isEmpty();
            assertThat(snapshot.hosts()).isEmpty();
            assertThat(snapshot.terminals()).isEmpty();
            assertThat(snapshot.leases()).isEmpty();
            assertThat(store.stored.control().hosts()).isEmpty();
        }
    }

    @Test
    void aFailedSavePreservesCredentialConnectionAndWorkspaceForRetry() {
        var store = new GatedStore();
        try (var room = new CredentialRoom(store)) {
            var credential = room.host();
            var host = room.givenConnected(credential, "Computer");
            host.session.handle(
                    new HostCommand.Inventory(List.of(new HostCommand.Runtime(7, "pty", 0, 0))));
            var before = store.stored;
            store.rejectWrites = true;

            var failure = catchThrowable(() -> room.revoke(credential));
            var closedAfterFailure = host.closed;
            var authorityAfterFailure =
                    room.rooms.authenticateCredential(room.state(), credential.secret());
            var terminalsAfterFailure = room.state().control.terminals();
            var storedAfterFailure = store.stored;
            store.rejectWrites = false;
            room.revoke(credential);

            assertThat(failure).isInstanceOf(IllegalStateException.class);
            assertThat(closedAfterFailure).isFalse();
            assertThat(authorityAfterFailure).contains(credential.subject());
            assertThat(terminalsAfterFailure).hasSize(1);
            assertThat(storedAfterFailure).isEqualTo(before);
            assertThat(host.closed).isTrue();
            assertThat(room.state().control.terminals()).isEmpty();
        }
    }

    @Test
    void revocationOfTheLastMemberKeepsTheManagedRoomAndIsIdempotent() {
        var store = new GatedStore();
        try (var room = new CredentialRoom(store)) {
            var credential = room.participant();
            var member = room.givenConnected(credential, "Only member");
            member.session.disconnect();
            var expired = room.expiry.getFirst();

            room.revoke(credential);
            var writesAfterRevocation = store.writes;
            expired.run();
            room.revoke(credential);
            var writesAfterRetry = store.writes;
            var newMember = room.connect(room.participant(), "New invitation registration");

            assertThat(writesAfterRetry).isEqualTo(writesAfterRevocation);
            assertThat(member.closed).isTrue();
            assertThat(newMember.welcome().participants())
                    .extracting(Participant::name)
                    .containsExactly("New invitation registration");
        }
    }

    @Test
    void inputUsesCommittedAuthorityDuringSavingAndStopsAfterRevocationCommits() throws Exception {
        var store = new GatedStore();
        try (var room = new CredentialRoom(store);
                var worker = Executors.newSingleThreadExecutor()) {
            var host = room.givenConnected(room.host(), "Computer");
            host.session.handle(
                    new HostCommand.Inventory(List.of(new HostCommand.Runtime(7, "pty", 0, 0))));
            host.session.handle(new HostCommand.InputState(true));
            var credential = room.participant();
            var alice = room.givenConnected(credential, "Alice");
            alice.session.handle(new ParticipantCommand.AcquireLease(7));
            var lease =
                    alice.notices.stream()
                            .filter(LeaseAccepted.class::isInstance)
                            .map(LeaseAccepted.class::cast)
                            .findFirst()
                            .orElseThrow();
            store.block = true;

            var revoking = worker.submit(() -> room.revoke(credential));
            try {
                if (!store.entered.await(5, TimeUnit.SECONDS))
                    throw new AssertionError("Save gate not reached");
                alice.session.input(new InputFrame(7, 1, lease.leaseId(), new byte[] {1}));
            } finally {
                store.release.countDown();
            }
            revoking.get(5, TimeUnit.SECONDS);
            alice.session.input(new InputFrame(7, 2, lease.leaseId(), new byte[] {2}));

            assertThat(host.inputs).extracting(InputFrame::seq).containsExactly(1L);
            assertThat(host.closed).isFalse();
            assertThat(alice.closed).isTrue();
            assertThat(room.state().control.leases()).isEmpty();
        }
    }

    @Test
    void unavailablePeerCannotUndoSavedRevocationOrHideItFromObservers() {
        try (var room = new CredentialRoom()) {
            var credential = room.participant();
            var alice = room.givenConnected(credential, "Alice");
            var bob = room.givenConnectedParticipant("Bob");
            alice.failSend = true;
            bob.notices.clear();

            room.revoke(credential);

            assertThat(alice.closed).isTrue();
            assertThat(bob.notices).containsExactly(new ParticipantLeft(credential.subject().id()));
            assertThat(room.rooms.authenticateCredential(room.state(), credential.secret()))
                    .isEmpty();
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void revocationAndHostReplacementFollowTheActualRoomCommandOrder(boolean revokeFirst)
            throws Exception {
        var store = new GatedStore();
        try (var room = new CredentialRoom(store);
                var workers = Executors.newFixedThreadPool(2)) {
            var credential = room.host();
            var original = room.givenConnected(credential, "Original");
            store.block = true;
            var replacement = new AtomicReference<Peer>();
            Runnable revoke = () -> room.revoke(credential);
            Runnable replace = () -> replacement.set(room.connect(credential, "Replacement"));
            var first = workers.submit(revokeFirst ? revoke : replace);
            boolean closedWhileSaving;
            boolean secondReturnedWhileSaving;
            try {
                if (!store.entered.await(5, TimeUnit.SECONDS))
                    throw new AssertionError("Save gate not reached");
                var queuedThread = new AtomicReference<Thread>();
                var second =
                        workers.submit(
                                () -> {
                                    queuedThread.set(Thread.currentThread());
                                    (revokeFirst ? replace : revoke).run();
                                });
                room.awaitQueued(queuedThread);
                closedWhileSaving = original.closed;
                secondReturnedWhileSaving = second.isDone();
                store.release.countDown();
                first.get(5, TimeUnit.SECONDS);
                second.get(5, TimeUnit.SECONDS);
            } finally {
                store.release.countDown();
            }

            assertThat(closedWhileSaving).isFalse();
            assertThat(secondReturnedWhileSaving).isFalse();
            assertThat(original.closed).isTrue();
            assertThat(replacement.get().closed).isTrue();
            assertThat(replacement.get().session != null).isEqualTo(!revokeFirst);
            assertThat(replacement.get().notices)
                    .contains(new Rejected("invalid-credential", "invalid-credential"));
            assertThat(store.stored.control().hosts()).isEmpty();
            assertThat(room.rooms.authenticateCredential(room.state(), credential.secret()))
                    .isEmpty();
        }
    }

    private static void assertRejected(Peer peer) {
        assertThat(peer.session).isNull();
        assertThat(peer.closed).isTrue();
        assertThat(peer.notices)
                .containsExactly(new Rejected("invalid-credential", "invalid-credential"));
    }
}

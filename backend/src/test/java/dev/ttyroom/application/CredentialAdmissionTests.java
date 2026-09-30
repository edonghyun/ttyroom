package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

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

class CredentialAdmissionTests {
    @Test
    void participantIdentityComesFromTheCredentialRecord() {
        try (var room = new CredentialRoom()) {
            var alice = room.participant();

            var connected = room.connect(alice, "Alice");
            var welcome = connected.welcome();

            assertThat(connected.session).isNotNull();
            assertThat(welcome.selfClientId()).isEqualTo(alice.subject().id());
            assertThat(welcome.participants())
                    .containsExactly(new Participant(alice.subject().id(), "Alice", null));
            assertThat(welcome.hosts()).isEmpty();
        }
    }

    @Test
    void hostIdentityAndRoleComeFromTheCredentialRecord() {
        try (var room = new CredentialRoom()) {
            var host = room.host();

            var connected = room.connect(host, "Computer");
            var welcome = connected.welcome();

            assertThat(connected.session).isNotNull();
            assertThat(welcome.selfClientId()).isEqualTo(host.subject().id());
            assertThat(welcome.participants()).isEmpty();
            assertThat(welcome.hosts())
                    .singleElement()
                    .satisfies(
                            state -> {
                                assertThat(state.hostId()).isEqualTo(host.subject().id());
                                assertThat(state.name()).isEqualTo("Computer");
                                assertThat(state.online()).isFalse();
                                assertThat(state.remoteInputAllowed()).isFalse();
                            });
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"invitation", "manager", "foreign", "revoked", "unknown"})
    void invalidCredentialsDoNotCreatePresenceOrDisturbTheCurrentConnection(String kind) {
        try (var room = new CredentialRoom()) {
            var original = room.givenConnectedParticipant("Alice");
            var secret = room.invalidCredential(kind);
            original.notices.clear();

            var rejected = room.connect(secret, "Attacker");
            var originalNotices = List.copyOf(original.notices);
            var observer = room.connect(room.participant(), "Observer");

            assertRejected(rejected, "invalid-credential", "invalid-credential");
            assertThat(original.closed).isFalse();
            assertThat(originalNotices).isEmpty();
            assertThat(observer.welcome().participants())
                    .extracting(Participant::name)
                    .containsExactly("Alice", "Observer");
        }
    }

    @Test
    void v8ProcessesRejectLegacyHelloEvenWithAValidInvitation() {
        try (var room = new CredentialRoom()) {
            var peer = new Peer();

            peer.session =
                    room.sessions.join(
                            new RoomSessions.Hello(
                                    7,
                                    room.invitation.roomId(),
                                    room.invitation.token(),
                                    "chosen",
                                    "Chosen",
                                    RoomSessions.Role.HOST),
                            peer);

            assertRejected(peer, "unsupported-protocol-version", "server=8");
        }
    }

    @Test
    void reconnectUsesTheSameSubjectAndOldDisconnectCommandsAndExpiryCannotRemoveIt() {
        try (var room = new CredentialRoom()) {
            var alice = room.participant();
            var old = room.givenConnected(alice, "Old Alice");
            var lease = room.givenTerminalLease(old);
            old.session.disconnect();
            var expiredCallback = room.expiry.getFirst();

            var replacement = room.connect(alice, "New Alice");
            old.session.disconnect();
            old.session.handle(new ParticipantCommand.MoveCursor(new CursorPosition(1, 2)));
            expiredCallback.run();
            var observer = room.connect(room.participant(), "Observer");

            assertThat(replacement.session).isNotNull();
            assertThat(replacement.welcome().selfClientId()).isEqualTo(alice.subject().id());
            assertThat(replacement.welcome().leases())
                    .singleElement()
                    .satisfies(
                            current -> {
                                assertThat(current.holderClientId())
                                        .isEqualTo(alice.subject().id());
                                assertThat(current.leaseId()).isEqualTo(lease.leaseId());
                            });
            assertThat(old.closed).isTrue();
            assertThat(replacement.closed).isFalse();
            assertThat(replacement.notices).noneMatch(ParticipantCursor.class::isInstance);
            assertThat(observer.welcome().participants())
                    .extracting(Participant::name)
                    .containsExactly("New Alice", "Observer");
        }
    }

    @Test
    void failedWelcomePreservesThePreviousAuthenticatedConnection() {
        try (var room = new CredentialRoom()) {
            var alice = room.participant();
            var old = room.givenConnected(alice, "Alice");
            var unavailable = new Peer();
            unavailable.failSend = true;

            room.connect(alice.secret(), "Replacement", unavailable);
            var observer = room.connect(room.participant(), "Observer");

            assertThat(unavailable.session).isNull();
            assertThat(unavailable.closed).isTrue();
            assertThat(old.closed).isFalse();
            assertThat(observer.welcome().participants())
                    .extracting(Participant::name)
                    .containsExactly("Alice", "Observer");
        }
    }

    @Test
    void revocationAlreadySavingWinsBeforeAnAdmissionQueuedBehindIt() throws Exception {
        var store = new GatedStore();
        try (var room = new CredentialRoom(store);
                var workers = Executors.newFixedThreadPool(2)) {
            var alice = room.participant();
            store.block = true;

            var revoking = workers.submit(() -> room.revoke(alice));
            var joiningThread = new AtomicReference<Thread>();
            Peer rejected;
            boolean returnedWhileSaving;
            try {
                if (!store.entered.await(5, TimeUnit.SECONDS))
                    throw new AssertionError("Revocation did not reach storage");
                var joining =
                        workers.submit(
                                () -> {
                                    joiningThread.set(Thread.currentThread());
                                    return room.connect(alice, "Late");
                                });
                room.awaitQueued(joiningThread);
                returnedWhileSaving = joining.isDone();
                store.release.countDown();
                revoking.get(5, TimeUnit.SECONDS);
                rejected = joining.get(5, TimeUnit.SECONDS);
            } finally {
                store.release.countDown();
            }

            assertThat(returnedWhileSaving).isFalse();
            assertRejected(rejected, "invalid-credential", "invalid-credential");
            assertThat(room.rooms.authenticateCredential(room.state(), alice.secret())).isEmpty();
        }
    }

    private static void assertRejected(Peer peer, String code, String message) {
        assertThat(peer.session).isNull();
        assertThat(peer.closed).isTrue();
        assertThat(peer.notices).containsExactly(new Rejected(code, message));
    }
}

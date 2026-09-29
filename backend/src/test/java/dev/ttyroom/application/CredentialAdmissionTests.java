package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.RoomNotice.*;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import java.util.concurrent.locks.ReentrantLock;

class CredentialAdmissionTests {
    @Test
    void participantIdentityComesFromTheCredentialRecord() {
        try (var room = new RegisteredRoom()) {
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
        try (var room = new RegisteredRoom()) {
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
        try (var room = new RegisteredRoom()) {
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
        try (var room = new RegisteredRoom()) {
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
        try (var room = new RegisteredRoom()) {
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
        try (var room = new RegisteredRoom()) {
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
        try (var room = new RegisteredRoom(store);
                var workers = Executors.newFixedThreadPool(2)) {
            var alice = room.participant();
            store.block = true;

            var revoking =
                    workers.submit(
                            () -> room.rooms.revokeCredential(room.state(), alice.subject().id()));
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

    private static final class RegisteredRoom implements AutoCloseable {
        final RoomDirectory rooms;
        final RoomDirectory.Invitation invitation;
        final List<Runnable> expiry = new ArrayList<>();
        final RoomSessions sessions;

        RegisteredRoom() {
            this(RoomStore.transientOnly());
        }

        RegisteredRoom(RoomStore store) {
            rooms = new RoomDirectory(store);
            invitation = rooms.create("Credential admission");
            var timers = mock(ExpiryTimers.class);
            when(timers.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS)))
                    .thenAnswer(
                            call -> {
                                expiry.add(call.getArgument(0));
                                return mock(ExpiryTimers.Cancellation.class);
                            });
            sessions =
                    new RoomSessions(
                            rooms,
                            timers,
                            RoomSessions.Policy.DEFAULT,
                            RoomSessions.AdmissionMode.CREDENTIAL_V8);
        }

        RoomDirectory.Room state() {
            return rooms.authenticatedRoom(invitation.roomId(), invitation.token());
        }

        LeaseAccepted givenTerminalLease(Peer participant) {
            var host = givenConnected(host(), "Computer");
            host.session.handle(
                    new HostCommand.Inventory(
                            List.of(new HostCommand.Runtime(7, "runtime", 0, 0))));
            host.session.handle(new HostCommand.InputState(true));
            participant.session.handle(new ParticipantCommand.AcquireLease(7));
            return participant.notices.stream()
                    .filter(LeaseAccepted.class::isInstance)
                    .map(LeaseAccepted.class::cast)
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException("Lease fixture failed"));
        }

        /** Observe this room's actual command queue, not an unrelated WAITING thread. */
        void awaitQueued(AtomicReference<Thread> thread) throws Exception {
            var field = RoomDirectory.Room.class.getDeclaredField("commands");
            field.setAccessible(true);
            var queue = (ReentrantLock) field.get(state());
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (thread.get() == null || !queue.hasQueuedThread(thread.get())) {
                if (System.nanoTime() >= deadline)
                    throw new AssertionError("Admission did not enter the room queue");
                LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
            }
        }

        RoomCredentials.Issued participant() {
            return rooms.registerParticipant(invitation.roomId(), invitation.token());
        }

        RoomCredentials.Issued host() {
            return rooms.registerHost(invitation.roomId(), invitation.managerCredential());
        }

        String invalidCredential(String kind) {
            return switch (kind) {
                case "invitation" -> invitation.token();
                case "manager" -> invitation.managerCredential();
                case "foreign" -> {
                    var other = rooms.create("Other");
                    yield rooms.registerParticipant(other.roomId(), other.token()).secret();
                }
                case "revoked" -> {
                    var revoked = participant();
                    rooms.revokeCredential(
                            rooms.authenticatedRoom(invitation.roomId(), invitation.token()),
                            revoked.subject().id());
                    yield revoked.secret();
                }
                case "unknown" -> "A".repeat(32);
                default -> throw new IllegalArgumentException("Unknown test case");
            };
        }

        Peer givenConnectedParticipant(String name) {
            return givenConnected(participant(), name);
        }

        Peer givenConnected(RoomCredentials.Issued credential, String name) {
            var peer = connect(credential, name);
            if (peer.session == null)
                throw new IllegalStateException("Connected participant fixture failed");
            return peer;
        }

        Peer connect(RoomCredentials.Issued credential, String name) {
            return connect(credential.secret(), name);
        }

        Peer connect(String secret, String name) {
            return connect(secret, name, new Peer());
        }

        Peer connect(String secret, String name, Peer peer) {
            peer.session =
                    sessions.join(
                            new RoomSessions.CredentialHello(8, invitation.roomId(), secret, name),
                            peer);
            return peer;
        }

        public void close() {
            sessions.close();
        }
    }

    private static final class GatedStore implements RoomStore {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        volatile boolean block;

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.of();
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (!block) return;
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS))
                    throw new IllegalStateException("Save gate timed out");
            } catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(failure);
            }
        }

        public void delete(String roomId) {}

        public void close() {}
    }

    private static final class Peer implements RoomSessions.Peer {
        final List<RoomNotice> notices = new ArrayList<>();
        RoomSessions.Session session;
        boolean closed;
        boolean failSend;

        Welcome welcome() {
            return notices.stream()
                    .filter(Welcome.class::isInstance)
                    .map(Welcome.class::cast)
                    .findFirst()
                    .orElseThrow(() -> new AssertionError("Expected welcome, received " + notices));
        }

        public void send(RoomNotice notice) {
            if (failSend) throw new RoomSessions.PeerUnavailable("Controlled transport failure");
            notices.add(notice);
        }

        public void sendInput(InputFrame frame) {
            throw new AssertionError("Unexpected input");
        }

        public boolean offerOutput(OutputFrame frame, OutputGap gap) {
            throw new AssertionError("Unexpected output");
        }

        public void replayOutput(List<OutputFrame> frames, Sync boundary) {
            notices.add(boundary);
        }

        public void close() {
            closed = true;
        }
    }
}

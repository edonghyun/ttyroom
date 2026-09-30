package dev.ttyroom.application;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.RoomNotice.*;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import java.util.concurrent.locks.ReentrantLock;

final class CredentialRoom implements AutoCloseable {
    final RoomDirectory rooms;
    final RoomDirectory.Invitation invitation;
    final List<Runnable> expiry = new ArrayList<>();
    final RoomSessions sessions;

    CredentialRoom() {
        this(RoomStore.transientOnly());
    }

    CredentialRoom(RoomStore store) {
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

    void revoke(RoomCredentials.Issued credential) {
        sessions.revokeCredential(
                invitation.roomId(), invitation.managerCredential(), credential.subject());
    }

    RoomDirectory.Room state() {
        return rooms.authenticatedRoom(invitation.roomId(), invitation.token());
    }

    LeaseAccepted givenTerminalLease(Peer participant) {
        var host = givenConnected(host(), "Computer");
        host.session.handle(
                new HostCommand.Inventory(List.of(new HostCommand.Runtime(7, "runtime", 0, 0))));
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
                throw new AssertionError("Operation did not enter the room queue");
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

    static final class GatedStore implements RoomStore {
        RoomDirectory.StoredRoom stored;
        int writes;
        boolean rejectWrites;
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        volatile boolean block;

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.of();
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (rejectWrites) throw new IllegalStateException("Controlled save failure");
            if (block) awaitRelease();
            stored = room;
            writes++;
        }

        private void awaitRelease() {
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

    static final class Peer implements RoomSessions.Peer {
        final List<RoomNotice> notices = new ArrayList<>();
        final List<InputFrame> inputs = new ArrayList<>();
        final List<OutputFrame> outputs = new ArrayList<>();
        RoomSessions.Session session;
        boolean closed;
        boolean failSend;
        boolean pauseReplay;
        final java.util.ArrayDeque<Runnable> replayCompletions = new java.util.ArrayDeque<>();

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
            inputs.add(frame);
        }

        public boolean offerOutput(OutputFrame frame, OutputGap gap) {
            outputs.add(frame);
            return true;
        }

        public void replayOutput(List<OutputFrame> frames, Sync boundary, Runnable afterSync) {
            notices.add(boundary);
            if (pauseReplay) replayCompletions.addLast(afterSync);
            else afterSync.run();
        }

        public void close() {
            closed = true;
            if (session != null) session.disconnect();
        }
    }
}

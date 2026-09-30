package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

@Timeout(10)
class ExpiryStorageTests {
    @Test
    void shutdownWaitsForTheInFlightSaveAndCancelsWaitingCleanup() throws Exception {
        try (var fixture = new Fixture();
                var client = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var room = fixture.rooms.create("Shutdown storage");
            fixture.keeper(room, new CountDownLatch(2));
            var first = fixture.host(room, "first");
            var second = fixture.host(room, "second");
            fixture.store.gatedRoom = room.roomId();
            first.disconnect();
            second.disconnect();
            await(fixture.store.entered);

            var closing = client.submit(fixture.sessions::close);
            boolean closedBeforeSave;
            boolean storeClosedBeforeSave;
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (retained(fixture.timers, "pending") != 0) {
                    if (System.nanoTime() >= deadline)
                        throw new AssertionError("Shutdown did not cancel waiting expiries");
                    java.util.concurrent.locks.LockSupport.parkNanos(
                            TimeUnit.MILLISECONDS.toNanos(1));
                }
                closedBeforeSave = closing.isDone();
                storeClosedBeforeSave = fixture.store.closed;
            } finally {
                fixture.store.release.countDown();
            }
            closing.get(3, TimeUnit.SECONDS);

            assertThat(closedBeforeSave).isFalse();
            assertThat(storeClosedBeforeSave).isFalse();
            assertThat(fixture.store.closed).isTrue();
            assertThat(retained(fixture.timers, "pending")).isZero();
            assertThat(retained(fixture.timers, "runningRooms")).isZero();
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {1, 2, 3})
    void delayedStorageRetainsCleanupWithoutBlockingAnotherRoom(int repetition) throws Exception {
        try (var fixture = new Fixture()) {
            var slowRoom = fixture.rooms.create("Slow storage");
            var healthyRoom = fixture.rooms.create("Healthy storage");
            var removed = new CountDownLatch(63);
            fixture.keeper(slowRoom, removed);
            var hosts = new ArrayList<RoomSessions.Session>();
            for (int i = 0; i < 63; i++) hosts.add(fixture.host(slowRoom, "host-" + i));
            var healthyRemoved = new CountDownLatch(1);
            fixture.keeper(healthyRoom, healthyRemoved);
            var healthyHost = fixture.host(healthyRoom, "healthy-host");
            fixture.store.gatedRoom = slowRoom.roomId();

            hosts.forEach(RoomSessions.Session::disconnect);
            await(fixture.store.entered);
            long started = System.nanoTime();
            healthyHost.disconnect();
            await(healthyRemoved);
            long independentMicros = (System.nanoTime() - started) / 1_000;
            var pendingDuringStorage = retained(fixture.timers, "pending");
            var slowStateDuringStorage = fixture.state(slowRoom);
            fixture.store.release.countDown();
            await(removed);
            var slowStateAfterDrain = fixture.state(slowRoom);
            fixture.sessions.close();
            var pendingAfterShutdown = retained(fixture.timers, "pending");
            var runningAfterShutdown = retained(fixture.timers, "runningRooms");

            assertThat(pendingDuringStorage).isEqualTo(62);
            assertThat(slowStateDuringStorage.control().hosts()).hasSize(63);
            assertThat(slowStateAfterDrain.control().hosts()).isEmpty();
            assertThat(pendingAfterShutdown).isZero();
            assertThat(runningAfterShutdown).isZero();
            assertThat(fixture.store.closed).isTrue();
            System.out.printf(
                    "EXPIRY_OBSERVATION"
                        + " {\"repetition\":%d,\"hosts\":63,\"pendingDuringStorage\":%d,\"healthyRoomCleanupMicros\":%d,\"removedAfterRelease\":63,\"pendingAfterShutdown\":%d,\"runningAfterShutdown\":%d}%n",
                    repetition,
                    pendingDuringStorage,
                    independentMicros,
                    pendingAfterShutdown,
                    runningAfterShutdown);
        }
    }

    // Structural observation is confined to this finite queue-retention experiment.
    private static int retained(ExpiryTimers timers, String name) throws Exception {
        var field = ExpiryTimers.class.getDeclaredField(name);
        field.setAccessible(true);
        synchronized (timers) {
            return ((Set<?>) field.get(timers)).size();
        }
    }

    private static void await(CountDownLatch gate) {
        try {
            if (!gate.await(3, TimeUnit.SECONDS))
                throw new AssertionError("Storage experiment timed out");
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new AssertionError(failure);
        }
    }

    private static final class Fixture implements AutoCloseable {
        final Store store = new Store();
        final RoomDirectory rooms = new RoomDirectory(store);
        final ExpiryTimers timers = new ExpiryTimers();
        final RoomSessions sessions =
                new RoomSessions(
                        rooms,
                        timers,
                        new RoomSessions.Policy(0, 0, 0),
                        RoomSessions.AdmissionMode.INVITATION_V7);

        RoomDirectory.StoredRoom state(RoomDirectory.Invitation room) {
            return rooms.authenticatedRoom(room.roomId(), room.token()).durableState();
        }

        void keeper(RoomDirectory.Invitation room, CountDownLatch removed) {
            var peer = mock(RoomSessions.Peer.class);
            doAnswer(
                            call -> {
                                if (call.getArgument(0) instanceof RoomNotice.HostRemoved)
                                    removed.countDown();
                                return null;
                            })
                    .when(peer)
                    .send(any());
            join(room, "keeper", RoomSessions.Role.PARTICIPANT, peer);
        }

        RoomSessions.Session host(RoomDirectory.Invitation room, String id) {
            return join(room, id, RoomSessions.Role.HOST, mock(RoomSessions.Peer.class));
        }

        RoomSessions.Session join(
                RoomDirectory.Invitation room,
                String id,
                RoomSessions.Role role,
                RoomSessions.Peer peer) {
            var session =
                    sessions.join(
                            new RoomSessions.Hello(7, room.roomId(), room.token(), id, id, role),
                            peer);
            if (session == null)
                throw new IllegalStateException("Experiment fixture admission failed");
            return session;
        }

        public void close() {
            store.release.countDown();
            sessions.close();
        }
    }

    private static final class Store implements RoomStore {
        volatile String gatedRoom;
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        boolean closed;

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.of();
        }

        public void save(RoomDirectory.StoredRoom record) {
            if (record.roomId().equals(gatedRoom)) {
                entered.countDown();
                await(release);
            }
        }

        public void delete(String id) {}

        public void close() {
            closed = true;
        }
    }
}

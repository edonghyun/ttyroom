package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Timeout(10)
class StoredHostCapacityTests {
    @Test
    void failedWelcomesCannotGrowTheRoomBeyondItsStoredHostBudget() {
        try (var fixture = new Fixture(2, 10)) {
            var room = fixture.room();
            room.failHostWelcome("first");
            room.failHostWelcome("second");

            var excess = room.host("excess");
            var retained = room.stored().control().hosts();

            assertThat(excess.session).isNull();
            assertThat(excess.notices)
                    .containsExactly(
                            new RoomNotice.Rejected(
                                    "capacity-exhausted", "room stored hosts capacity exhausted"));
            assertThat(retained)
                    .extracting(host -> host.hostId())
                    .containsExactly("first", "second");
        }
    }

    @Test
    void storedHostsInDifferentRoomsShareTheGlobalBudget() {
        try (var fixture = new Fixture(3, 1)) {
            var first = fixture.room();
            var second = fixture.room();
            first.failHostWelcome("retained");

            var excess = second.host("excess");
            var participant = second.participant("alice");

            assertThat(excess.session).isNull();
            assertThat(excess.notices)
                    .containsExactly(
                            new RoomNotice.Rejected(
                                    "capacity-exhausted", "stored hosts capacity exhausted"));
            assertThat(participant.session).isNotNull();
            assertThat(second.stored().control().hosts()).isEmpty();
        }
    }

    @Test
    void repeatedFailedWelcomesAndReconnectReuseTheSameStoredIdentity() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();
            room.failHostWelcome("retained");

            for (int i = 0; i < 20; i++) room.failHostWelcome("retained");
            var restored = room.host("retained");
            var excess = room.host("new");

            assertThat(restored.session).isNotNull();
            assertThat(excess.session).isNull();
            assertThat(room.stored().control().hosts()).hasSize(1);
        }
    }

    @Test
    void failedStorageReturnsBothHostAndMembershipReservations() {
        try (var fixture = new Fixture(1, 1)) {
            var first = fixture.room();
            var second = fixture.room();
            fixture.store.failSave = true;

            var failure = catchThrowable(() -> first.host("failed"));
            fixture.store.failSave = false;
            var accepted = second.host("accepted");
            var excess = first.host("excess");

            assertThat(failure).hasMessage("save failed");
            assertThat(accepted.session).isNotNull();
            assertThat(excess.session).isNull();
            assertThat(first.stored().control().hosts()).isEmpty();
        }
    }

    @Test
    void failedExpiryPreservesTheWorkspaceAndOnlySavedRemovalReleasesCapacity() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();
            room.participant("keeper");
            var host = room.host("owner");
            host.session.handle(
                    new HostCommand.Inventory(
                            List.of(new HostCommand.Runtime(7, "runtime", 0, 0))));
            host.session.disconnect();
            var expiry = fixture.expiries.getLast();
            fixture.store.failSave = true;

            var failure = catchThrowable(expiry::run);
            var preserved = room.stored();
            fixture.store.failSave = false;
            var stillFull = room.host("replacement");
            expiry.run();
            expiry.run();
            var accepted = room.host("replacement");
            var excess = room.host("excess");

            assertThat(failure).hasMessage("save failed");
            assertThat(preserved.control().hosts()).hasSize(1);
            assertThat(preserved.control().workspace().terminals()).hasSize(1);
            assertThat(stillFull.session).isNull();
            assertThat(accepted.session).isNotNull();
            assertThat(excess.session).isNull();
            assertThat(room.stored().control().workspace().terminals()).isEmpty();
        }
    }

    @Test
    void restoreCountsOfflineHostsAndKeepsTheirTerminalOwnership() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();
            var host = room.host("owner");
            host.session.handle(
                    new HostCommand.Inventory(
                            List.of(new HostCommand.Runtime(7, "runtime", 0, 0))));

            fixture.restart();
            room.failHostWelcome("owner");
            var excess = room.host("new");
            var recovered = room.host("owner");
            recovered.session.handle(
                    new HostCommand.Inventory(
                            List.of(new HostCommand.Runtime(7, "runtime", 0, 0))));
            var stored = room.stored();

            assertThat(excess.session).isNull();
            assertThat(recovered.session).isNotNull();
            assertThat(stored.control().hosts())
                    .extracting(hostIdentity -> hostIdentity.hostId())
                    .containsExactly("owner");
            assertThat(stored.control().workspace().terminals())
                    .singleElement()
                    .satisfies(
                            terminal -> {
                                assertThat(terminal.view().terminalId()).isEqualTo(7);
                                assertThat(terminal.view().hostId()).isEqualTo("owner");
                            });
        }
    }

    @Test
    void revocationReturnsCapacityOnlyAfterSavedRemovalAndOnlyOnce() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();
            var issued =
                    fixture.rooms.registerHost(
                            room.invitation.roomId(), room.invitation.managerCredential());
            room.host(issued.subject().id());
            fixture.store.failSave = true;

            var failure =
                    catchThrowable(
                            () ->
                                    fixture.sessions.revokeCredential(
                                            room.invitation.roomId(),
                                            room.invitation.managerCredential(),
                                            issued.subject()));
            fixture.store.failSave = false;
            var stillFull = room.host("too-early");
            fixture.sessions.revokeCredential(
                    room.invitation.roomId(),
                    room.invitation.managerCredential(),
                    issued.subject());
            fixture.sessions.revokeCredential(
                    room.invitation.roomId(),
                    room.invitation.managerCredential(),
                    issued.subject());
            var accepted = room.host("replacement");
            var excess = room.host("excess");

            assertThat(failure).hasMessage("save failed");
            assertThat(stillFull.session).isNull();
            assertThat(accepted.session).isNotNull();
            assertThat(excess.session).isNull();
        }
    }

    @Test
    void failedRoomDeletionKeepsStoredHostsUntilSuccessfulDeletion() {
        try (var fixture = new Fixture(1, 1)) {
            var first = fixture.room();
            var second = fixture.room();
            first.failHostWelcome("retained");
            fixture.store.failDelete = true;

            var failure = catchThrowable(first::remove);
            var full = second.host("new");
            fixture.store.failDelete = false;
            var originalState =
                    fixture.rooms.authenticatedRoom(
                            first.invitation.roomId(), first.invitation.token());
            first.remove();
            fixture.rooms.execute(
                    originalState,
                    operation -> {
                        operation.remove();
                        return null;
                    });
            var accepted = second.host("new");
            var excess = second.host("excess");

            assertThat(failure).hasMessage("delete failed");
            assertThat(full.session).isNull();
            assertThat(accepted.session).isNotNull();
            assertThat(excess.session).isNull();
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.MethodSource("insufficientHostBudgets")
    void restoringTooManyStoredHostsFailsWithoutDeletingThem(RoomDirectory.Limits limits) {
        Store store;
        try (var fixture = new Fixture(2, 2)) {
            var room = fixture.room();
            room.failHostWelcome("first");
            room.failHostWelcome("second");
            store = fixture.store;
        }
        store.closed = false;

        var failure = catchThrowable(() -> new RoomDirectory(store, limits));

        assertThat(failure).isInstanceOf(RoomDirectory.CapacityExceeded.class);
        assertThat(store.closed).isTrue();
        assertThat(store.loadAll().getFirst().control().hosts()).hasSize(2);
    }

    private static java.util.stream.Stream<RoomDirectory.Limits> insufficientHostBudgets() {
        return java.util.stream.Stream.of(
                new RoomDirectory.Limits(4, 16, 64, 128, 1, 2),
                new RoomDirectory.Limits(4, 16, 64, 128, 2, 1));
    }

    @Test
    void simultaneousRoomsCannotBothClaimTheLastStoredHostSlot() throws Exception {
        try (var fixture = new Fixture(1, 1);
                var workers = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var first = fixture.room();
            var second = fixture.room();
            var start = new java.util.concurrent.CountDownLatch(1);
            var a =
                    workers.submit(
                            () -> {
                                await(start);
                                return first.host("a");
                            });
            var b =
                    workers.submit(
                            () -> {
                                await(start);
                                return second.host("b");
                            });

            start.countDown();
            var results = List.of(a.get(3, TimeUnit.SECONDS), b.get(3, TimeUnit.SECONDS));

            assertThat(results).filteredOn(joined -> joined.session != null).hasSize(1);
            assertThat(results).filteredOn(joined -> joined.session == null).hasSize(1);
            assertThat(
                            first.stored().control().hosts().size()
                                    + second.stored().control().hosts().size())
                    .isEqualTo(1);
        }
    }

    @Test
    void aHostWaitingForStorageReservesCapacityWithoutHoldingOtherRooms() throws Exception {
        try (var fixture = new Fixture(1, 1);
                var worker = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var first = fixture.room();
            var second = fixture.room();
            fixture.store.gatedRoom = first.invitation.roomId();
            var saving = worker.submit(() -> first.host("saving"));
            await(fixture.store.entered);

            Joined excess;
            try {
                excess = second.host("excess");
            } finally {
                fixture.store.release.countDown();
            }
            var accepted = saving.get(3, TimeUnit.SECONDS);

            assertThat(excess.session).isNull();
            assertThat(accepted.session).isNotNull();
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(ints = {1, 2, 3})
    void repeatedFailedAdmissionStaysBoundedAcrossCleanupAndRestart(int repetition) {
        try (var fixture = new Fixture(4, 6)) {
            var first = fixture.room();
            var second = fixture.room();
            first.participant("keeper");
            int rejected = 0;
            for (var room : List.of(first, second)) {
                for (int i = 0; i < 20; i++) {
                    var attempt = room.failHostWelcome("host-" + i);
                    if (attempt.notices.stream().anyMatch(RoomNotice.Rejected.class::isInstance))
                        rejected++;
                }
            }
            int afterFailedAdmissions = fixture.storedHostCount();
            var countsAfterCleanup = new ArrayList<Integer>();
            var countsAfterReplacement = new ArrayList<Integer>();
            String current = "host-0";

            for (int i = 0; i < 20; i++) {
                first.host(current).session.disconnect();
                fixture.expiries.getLast().run();
                countsAfterCleanup.add(fixture.storedHostCount());
                current = "replacement-" + i;
                first.failHostWelcome(current);
                countsAfterReplacement.add(fixture.storedHostCount());
            }
            fixture.restart();
            int afterRestart = fixture.storedHostCount();
            var recovered = first.host(current);
            var healthy = second.participant("healthy");

            assertThat(rejected).isEqualTo(34);
            assertThat(afterFailedAdmissions).isEqualTo(6);
            assertThat(countsAfterCleanup).containsOnly(5).hasSize(20);
            assertThat(countsAfterReplacement).containsOnly(6).hasSize(20);
            assertThat(afterRestart).isEqualTo(6);
            assertThat(recovered.session).isNotNull();
            assertThat(healthy.session).isNotNull();
            System.out.printf(
                    "STORED_HOST_OBSERVATION"
                        + " {\"repetition\":%d,\"uniqueAdmissionAttempts\":40,\"capacityRejections\":%d,\"retainedAfterAttempts\":%d,\"cleanupReplacementRounds\":20,\"afterEachCleanup\":5,\"afterEachReplacement\":6,\"afterRestart\":%d}%n",
                    repetition, rejected, afterFailedAdmissions, afterRestart);
        }
    }

    private static void await(java.util.concurrent.CountDownLatch gate)
            throws InterruptedException {
        if (!gate.await(3, TimeUnit.SECONDS))
            throw new AssertionError("Host storage gate timed out");
    }

    private record Joined(RoomSessions.Session session, List<RoomNotice> notices) {}

    private static final class Fixture implements AutoCloseable {
        final Store store = new Store();
        RoomDirectory rooms;
        RoomSessions sessions;
        final RoomDirectory.Limits limits;
        final List<Runnable> expiries = new ArrayList<>();

        Fixture(int perRoom, int total) {
            limits = new RoomDirectory.Limits(4, 16, 64, 128, perRoom, total);
            start();
        }

        void restart() {
            sessions.close();
            expiries.clear();
            store.closed = false;
            start();
        }

        void start() {
            rooms = new RoomDirectory(store, limits);
            var timers = mock(ExpiryTimers.class);
            when(timers.schedule(any(), any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS)))
                    .thenAnswer(
                            call -> {
                                expiries.add(call.getArgument(1));
                                return mock(ExpiryTimers.Cancellation.class);
                            });
            sessions = new RoomSessions(rooms, timers);
        }

        int storedHostCount() {
            return store.loadAll().stream().mapToInt(room -> room.control().hosts().size()).sum();
        }

        ManagedRoom room() {
            return new ManagedRoom(this, rooms.create("Stored hosts"));
        }

        public void close() {
            store.release.countDown();
            sessions.close();
        }
    }

    private record ManagedRoom(Fixture fixture, RoomDirectory.Invitation invitation) {
        Joined host(String id) {
            return join(id, RoomSessions.Role.HOST, null);
        }

        Joined participant(String id) {
            return join(id, RoomSessions.Role.PARTICIPANT, null);
        }

        Joined failHostWelcome(String id) {
            var notices = new ArrayList<RoomNotice>();
            var unavailable = mock(RoomSessions.Peer.class);
            doAnswer(
                            call -> {
                                RoomNotice notice = call.getArgument(0);
                                notices.add(notice);
                                if (notice instanceof RoomNotice.Welcome)
                                    throw new RoomSessions.PeerUnavailable("welcome unavailable");
                                return null;
                            })
                    .when(unavailable)
                    .send(any());
            var joined = join(id, RoomSessions.Role.HOST, unavailable);
            return new Joined(joined.session, notices);
        }

        Joined join(String id, RoomSessions.Role role, RoomSessions.Peer supplied) {
            var notices = new ArrayList<RoomNotice>();
            var peer = supplied == null ? mock(RoomSessions.Peer.class) : supplied;
            if (supplied == null)
                doAnswer(
                                call -> {
                                    notices.add(call.getArgument(0));
                                    return null;
                                })
                        .when(peer)
                        .send(any());
            var session =
                    fixture.sessions.join(
                            new RoomSessions.Hello(
                                    7, invitation.roomId(), invitation.token(), id, id, role),
                            peer);
            return new Joined(session, notices);
        }

        void remove() {
            var state = fixture.rooms.authenticatedRoom(invitation.roomId(), invitation.token());
            fixture.rooms.execute(
                    state,
                    operation -> {
                        operation.remove();
                        return null;
                    });
        }

        RoomDirectory.StoredRoom stored() {
            return fixture.rooms
                    .authenticatedRoom(invitation.roomId(), invitation.token())
                    .durableState();
        }
    }

    private static final class Store implements RoomStore {
        final Map<String, RoomDirectory.StoredRoom> records = new ConcurrentHashMap<>();
        final java.util.concurrent.CountDownLatch entered =
                new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch release =
                new java.util.concurrent.CountDownLatch(1);
        String gatedRoom;
        boolean failSave;
        boolean failDelete;
        boolean closed;

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.copyOf(records.values());
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (failSave) throw new IllegalStateException("save failed");
            if (room.roomId().equals(gatedRoom)) {
                entered.countDown();
                try {
                    await(release);
                } catch (InterruptedException failure) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(failure);
                }
            }
            records.put(room.roomId(), room);
        }

        public void delete(String id) {
            if (failDelete) throw new IllegalStateException("delete failed");
            records.remove(id);
        }

        public void close() {
            closed = true;
        }
    }
}

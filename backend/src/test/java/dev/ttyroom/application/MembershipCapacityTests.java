package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

class MembershipCapacityTests {
    @Test
    void failedLegacyHostWelcomeLeavesDurableIdentitiesOutsideTheLiveBudget() {
        try (var fixture = new Fixture(2, 2)) {
            var room = fixture.room();
            fixture.join(room, "keeper");
            var unavailable = mock(RoomSessions.Peer.class);
            doThrow(new RoomSessions.PeerUnavailable("closed")).when(unavailable).send(any());

            for (int i = 0; i < 3; i++)
                fixture.join(room, "offline-" + i, RoomSessions.Role.HOST, unavailable);
            var state = fixture.rooms.authenticatedRoom(room.roomId(), room.token()).durableState();
            var participant = fixture.join(room, "participant");

            assertThat(state.control().hosts()).hasSize(3);
            assertThat(fixture.expiries).isEmpty();
            assertThat(participant.session).isNotNull();
        }
    }

    @Test
    void disconnectedMembersStillOccupyTheRoomBudget() {
        try (var fixture = new Fixture(2, 10)) {
            var room = fixture.room();
            fixture.join(room, "keeper");
            var departing = fixture.join(room, "departing");

            departing.session.disconnect();
            var excess = fixture.join(room, "excess");

            assertThat(excess.session).isNull();
            assertThat(excess.notices)
                    .containsExactly(
                            new RoomNotice.Rejected(
                                    "capacity-exhausted", "room memberships capacity exhausted"));
        }
    }

    @Test
    void differentRoomsShareTheMembershipBudget() {
        try (var fixture = new Fixture(3, 2)) {
            var first = fixture.room();
            var second = fixture.room();
            fixture.join(first, "alice");
            fixture.join(second, "bob");

            var excess = fixture.join(second, "charlie");

            assertThat(excess.session).isNull();
            assertThat(excess.notices)
                    .containsExactly(
                            new RoomNotice.Rejected(
                                    "capacity-exhausted", "memberships capacity exhausted"));
        }
    }

    @Test
    void replacementAndStaleExpiryCannotFreeAnOccupiedSlot() {
        try (var fixture = new Fixture(2, 2)) {
            var room = fixture.room();
            fixture.join(room, "keeper");
            fixture.join(room, "alice").session.disconnect();
            var stale = fixture.expiries.getFirst();

            var replacement = fixture.join(room, "alice");
            stale.run();
            stale.run();
            var excess = fixture.join(room, "bob");
            replacement.session.disconnect();
            fixture.expiries.getLast().run();
            var accepted = fixture.join(room, "bob");
            var stillFull = fixture.join(room, "charlie");

            assertThat(replacement.session).isNotNull();
            assertThat(excess.session).isNull();
            assertThat(accepted.session).isNotNull();
            assertThat(stillFull.session).isNull();
        }
    }

    @Test
    void aFullRoomDoesNotPreventAnotherRoomFromUsingItsOwnBudget() {
        try (var fixture = new Fixture(1, 2)) {
            var first = fixture.room();
            var second = fixture.room();
            fixture.join(first, "alice");

            var excess = fixture.join(first, "bob");
            var independent = fixture.join(second, "charlie");

            assertThat(excess.session).isNull();
            assertThat(independent.session).isNotNull();
        }
    }

    @Test
    void failedWelcomeReturnsTheReservationAndKeepsThePreviousMemberResponsive() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();
            var unavailable = mock(RoomSessions.Peer.class);
            doThrow(new RoomSessions.PeerUnavailable("closed")).when(unavailable).send(any());

            var failed = fixture.join(room, "failed", RoomSessions.Role.PARTICIPANT, unavailable);
            var original = fixture.join(room, "alice");
            var replacement =
                    fixture.join(room, "alice", RoomSessions.Role.PARTICIPANT, unavailable);
            var excess = fixture.join(room, "bob");
            original.notices.clear();
            original.session.handle(new ParticipantCommand.AcquireLease(42));

            assertThat(original.notices)
                    .singleElement()
                    .isInstanceOf(RoomNotice.LeaseInvalid.class);
            assertThat(failed.session).isNull();
            assertThat(original.session).isNotNull();
            assertThat(replacement.session).isNull();
            assertThat(excess.session).isNull();
        }
    }

    @Test
    void failedHostSaveReturnsCapacityAndDoesNotRememberTheHost() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();
            fixture.store.failSave = true;

            var failure =
                    catchThrowable(() -> fixture.join(room, "host", RoomSessions.Role.HOST, null));
            fixture.store.failSave = false;
            var participant = fixture.join(room, "alice");
            var state = fixture.rooms.authenticatedRoom(room.roomId(), room.token()).durableState();

            assertThat(failure).hasMessage("save failed");
            assertThat(participant.session).isNotNull();
            assertThat(state.control().hosts()).isEmpty();
        }
    }

    @Test
    void hostsAndParticipantsShareTheBudgetAndRevocationReturnsItOnlyOnce() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();
            var host = fixture.rooms.registerHost(room.roomId(), room.managerCredential());
            fixture.join(room, host.subject().id(), RoomSessions.Role.HOST, null);

            var excess = fixture.join(room, "alice");
            fixture.sessions.revokeCredential(
                    room.roomId(), room.managerCredential(), host.subject());
            fixture.sessions.revokeCredential(
                    room.roomId(), room.managerCredential(), host.subject());
            var accepted = fixture.join(room, "alice");
            var stillFull = fixture.join(room, "bob");

            assertThat(excess.session).isNull();
            assertThat(accepted.session).isNotNull();
            assertThat(stillFull.session).isNull();
        }
    }

    @Test
    void expiringTheLastMemberReturnsCapacityForAnotherRoom() {
        try (var fixture = new Fixture(1, 1)) {
            var first = fixture.room();
            var second = fixture.room();
            fixture.join(first, "alice").session.disconnect();

            fixture.expiries.getFirst().run();
            fixture.expiries.getFirst().run();
            var accepted = fixture.join(second, "bob");
            var excess = fixture.join(second, "charlie");

            assertThat(fixture.rooms.acceptsToken(first.roomId(), first.token())).isFalse();
            assertThat(accepted.session).isNotNull();
            assertThat(excess.session).isNull();
        }
    }

    @Test
    void concurrentRoomsCannotBothReserveTheLastMembership() throws Exception {
        try (var fixture = new Fixture(2, 1);
                var workers = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var first = fixture.room();
            var second = fixture.room();
            var start = new java.util.concurrent.CountDownLatch(1);
            var a =
                    workers.submit(
                            () -> {
                                start.await(2, TimeUnit.SECONDS);
                                return fixture.join(first, "alice");
                            });
            var b =
                    workers.submit(
                            () -> {
                                start.await(2, TimeUnit.SECONDS);
                                return fixture.join(second, "bob");
                            });

            start.countDown();
            var results = List.of(a.get(3, TimeUnit.SECONDS), b.get(3, TimeUnit.SECONDS));

            assertThat(results).filteredOn(joined -> joined.session != null).hasSize(1);
            assertThat(results).filteredOn(joined -> joined.session == null).hasSize(1);
        }
    }

    private record Joined(RoomSessions.Session session, List<RoomNotice> notices) {}

    private static final class Fixture implements AutoCloseable {
        final Store store = new Store();
        final RoomDirectory rooms = new RoomDirectory(store);
        final ExpiryTimers timers = mock(ExpiryTimers.class);
        final List<Runnable> expiries = new ArrayList<>();
        final RoomSessions sessions;

        Fixture(int perRoom, int total) {
            when(timers.schedule(any(), any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS)))
                    .thenAnswer(
                            call -> {
                                expiries.add(call.getArgument(1));
                                return mock(ExpiryTimers.Cancellation.class);
                            });
            sessions =
                    new RoomSessions(
                            rooms,
                            timers,
                            RoomSessions.Policy.DEFAULT,
                            RoomSessions.AdmissionMode.INVITATION_V7,
                            new RoomSessions.Limits(perRoom, total));
        }

        RoomDirectory.Invitation room() {
            return rooms.create("Membership capacity");
        }

        Joined join(RoomDirectory.Invitation room, String id) {
            return join(room, id, RoomSessions.Role.PARTICIPANT, null);
        }

        Joined join(
                RoomDirectory.Invitation room,
                String id,
                RoomSessions.Role role,
                RoomSessions.Peer supplied) {
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
                    sessions.join(
                            new RoomSessions.Hello(7, room.roomId(), room.token(), id, id, role),
                            peer);
            return new Joined(session, notices);
        }

        public void close() {
            sessions.close();
        }
    }

    private static final class Store implements RoomStore {
        boolean failSave;

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.of();
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (failSave) throw new IllegalStateException("save failed");
        }

        public void delete(String id) {}

        public void close() {}
    }
}

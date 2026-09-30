package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.*;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.*;
import java.util.stream.Stream;

@Timeout(10)
class CredentialCapacityTests {
    @Test
    void theManagerAlreadyConsumesOneRoomCredentialSlot() {
        try (var rooms =
                new RoomDirectory(
                        RoomStore.transientOnly(), new RoomDirectory.Limits(2, 1, 2, 10))) {
            var room = rooms.create("Room");
            var participant = rooms.registerParticipant(room.roomId(), room.token());

            var excess =
                    catchThrowable(
                            () -> rooms.registerHost(room.roomId(), room.managerCredential()));
            var retained =
                    rooms.authenticateCredential(
                            rooms.authenticatedRoom(room.roomId(), room.token()),
                            participant.secret());

            assertThat(excess)
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class)
                    .hasMessage("room credentials capacity exhausted");
            assertThat(retained).contains(participant.subject());
        }
    }

    @Test
    void credentialsInDifferentRoomsShareTheGlobalBudget() {
        try (var rooms =
                new RoomDirectory(
                        RoomStore.transientOnly(), new RoomDirectory.Limits(3, 1, 5, 3))) {
            var first = rooms.create("First");
            var second = rooms.create("Second");
            rooms.registerParticipant(first.roomId(), first.token());

            var excess =
                    catchThrowable(
                            () -> rooms.registerParticipant(second.roomId(), second.token()));
            var excessManager = catchThrowable(() -> rooms.create("Third"));

            assertThat(excess)
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class)
                    .hasMessage("credentials capacity exhausted");
            assertThat(excessManager).isInstanceOf(RoomDirectory.CapacityExceeded.class);
        }
    }

    @Test
    void failedIssuanceReturnsTheGlobalReservation() {
        try (var fixture = new Fixture(3, 3)) {
            var first = fixture.room();
            var second = fixture.room();
            fixture.store.failSave = true;

            var failure = catchThrowable(first::participant);
            fixture.store.failSave = false;
            var accepted = second.participant();
            var excess = catchThrowable(first::participant);

            assertThat(failure).hasMessage("save failed");
            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(first.count()).isEqualTo(1);
            assertThat(second.authenticate(accepted.secret())).contains(accepted.subject());
        }
    }

    @Test
    void failedRevocationPreservesAuthorityAndOnlySuccessfulRevocationFreesCapacity() {
        try (var fixture = new Fixture(2, 2)) {
            var room = fixture.room();
            var original = room.participant();
            fixture.store.failSave = true;

            var failure = catchThrowable(() -> room.revoke(original));
            var stillValid = room.authenticate(original.secret());
            fixture.store.failSave = false;
            var stillFull = catchThrowable(room::participant);
            room.revoke(original);
            room.revoke(original);
            var replacement = room.participant();
            var excess = catchThrowable(room::participant);

            assertThat(failure).hasMessage("save failed");
            assertThat(stillValid).contains(original.subject());
            assertThat(stillFull).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(room.authenticate(original.secret())).isEmpty();
            assertThat(room.authenticate(replacement.secret())).contains(replacement.subject());
            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
        }
    }

    @Test
    void failedManagerBootstrapReturnsTheRoomAndCredentialReservations() {
        try (var fixture = new Fixture(1, 1)) {
            fixture.store.failSave = true;

            var failure = catchThrowable(fixture::room);
            fixture.store.failSave = false;
            var accepted = fixture.room();
            var excess = catchThrowable(fixture::room);

            assertThat(failure).hasMessage("save failed");
            assertThat(accepted.count()).isEqualTo(1);
            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
        }
    }

    @Test
    void deletingARoomReturnsItsCredentialsOnlyAfterStorageSucceeds() {
        try (var fixture = new Fixture(2, 2)) {
            var original = fixture.room();
            original.participant();
            fixture.store.failDelete = true;

            var failure = catchThrowable(original::remove);
            var stillFull = catchThrowable(fixture::room);
            fixture.store.failDelete = false;
            original.remove();
            original.remove();
            var replacement = fixture.room();
            replacement.participant();
            var excess = catchThrowable(replacement::participant);

            assertThat(failure).hasMessage("delete failed");
            assertThat(stillFull).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(replacement.count()).isEqualTo(2);
        }
    }

    @Test
    void authenticationIsCheckedBeforeRevealingCapacity() {
        try (var fixture = new Fixture(1, 1)) {
            var room = fixture.room();

            var failure =
                    catchThrowable(() -> fixture.rooms.registerParticipant(room.state.id, "wrong"));

            assertThat(failure).isInstanceOf(RoomDirectory.RegistrationRejected.class);
        }
    }

    @Test
    void simultaneousIssuanceInDifferentRoomsCannotBothClaimTheLastSlot() throws Exception {
        try (var fixture = new Fixture(3, 3);
                var workers = Executors.newFixedThreadPool(2)) {
            var first = fixture.room();
            var second = fixture.room();
            var start = new CountDownLatch(1);
            var a =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(first::participant);
                            });
            var b =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(second::participant);
                            });

            start.countDown();
            var failures =
                    java.util.Arrays.asList(a.get(3, TimeUnit.SECONDS), b.get(3, TimeUnit.SECONDS));

            assertThat(failures)
                    .filteredOn(java.util.Objects::nonNull)
                    .singleElement()
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(first.count() + second.count()).isEqualTo(3);
        }
    }

    @Test
    void pendingStorageReservesCapacityWithoutBlockingOtherRooms() throws Exception {
        try (var fixture = new Fixture(3, 3);
                var worker = Executors.newSingleThreadExecutor()) {
            var first = fixture.room();
            var second = fixture.room();
            fixture.store.gatedRoom = first.state.id;

            var saving = worker.submit(first::participant);
            await(fixture.store.entered);
            Throwable excess;
            try {
                excess = catchThrowable(second::participant);
            } finally {
                fixture.store.release.countDown();
            }
            var issued = saving.get(3, TimeUnit.SECONDS);

            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(first.authenticate(issued.secret())).contains(issued.subject());
        }
    }

    @Test
    void restoredCredentialsConsumeCapacityAndPreserveAuthentication() {
        var store = new Store();
        RoomDirectory.Invitation invitation;
        RoomCredentials.Issued issued;
        try (var original = new RoomDirectory(store)) {
            invitation = original.create("Saved");
            issued = original.registerParticipant(invitation.roomId(), invitation.token());
        }
        try (var restored = new RoomDirectory(store, new RoomDirectory.Limits(2, 1, 2, 2))) {
            var excess =
                    catchThrowable(
                            () ->
                                    restored.registerParticipant(
                                            invitation.roomId(), invitation.token()));
            var state = restored.authenticatedRoom(invitation.roomId(), invitation.token());

            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(restored.authenticateCredential(state, issued.secret()))
                    .contains(issued.subject());
        }
    }

    @ParameterizedTest
    @MethodSource("insufficientRestorationBudgets")
    void anOversizedStoreFailsStartupWithoutDeletingData(RoomDirectory.Limits limits) {
        var store = new Store();
        try (var original = new RoomDirectory(store)) {
            var invitation = original.create("Saved");
            original.registerParticipant(invitation.roomId(), invitation.token());
        }
        store.closed = false;

        var failure = catchThrowable(() -> new RoomDirectory(store, limits));

        assertThat(failure).isInstanceOf(RoomDirectory.CapacityExceeded.class);
        assertThat(store.closed).isTrue();
        assertThat(store.loadAll().getFirst().credentials()).hasSize(2);
    }

    private static Stream<RoomDirectory.Limits> insufficientRestorationBudgets() {
        return Stream.of(
                new RoomDirectory.Limits(2, 1, 1, 2), new RoomDirectory.Limits(2, 1, 2, 1));
    }

    @Test
    void simultaneousIssuanceInOneRoomRespectsItsOwnBudget() throws Exception {
        try (var fixture = new Fixture(2, 10);
                var workers = Executors.newFixedThreadPool(2)) {
            var room = fixture.room();
            var start = new CountDownLatch(1);
            var a =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(room::participant);
                            });
            var b =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(room::participant);
                            });

            start.countDown();
            var failures =
                    java.util.Arrays.asList(a.get(3, TimeUnit.SECONDS), b.get(3, TimeUnit.SECONDS));

            assertThat(failures)
                    .filteredOn(java.util.Objects::nonNull)
                    .singleElement()
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(room.count()).isEqualTo(2);
        }
    }

    private static void await(CountDownLatch gate) throws InterruptedException {
        if (!gate.await(3, TimeUnit.SECONDS))
            throw new AssertionError("Credential storage gate timed out");
    }

    private static final class Fixture implements AutoCloseable {
        final Store store = new Store();
        final RoomDirectory rooms;

        Fixture(int perRoom, int total) {
            rooms = new RoomDirectory(store, new RoomDirectory.Limits(4, 16, perRoom, total));
        }

        ManagedRoom room() {
            var invitation = rooms.create("Credential capacity");
            return new ManagedRoom(
                    rooms,
                    invitation,
                    rooms.authenticatedRoom(invitation.roomId(), invitation.token()));
        }

        public void close() {
            store.release.countDown();
            rooms.close();
        }
    }

    private record ManagedRoom(
            RoomDirectory rooms, RoomDirectory.Invitation invitation, RoomDirectory.Room state) {
        RoomCredentials.Issued participant() {
            return rooms.registerParticipant(invitation.roomId(), invitation.token());
        }

        Optional<RoomCredentials.Subject> authenticate(String secret) {
            return rooms.authenticateCredential(state, secret);
        }

        int count() {
            return state.durableState().credentials().size();
        }

        void revoke(RoomCredentials.Issued issued) {
            rooms.execute(
                    state,
                    operation -> {
                        operation.revokeCredential(
                                invitation.managerCredential(), issued.subject(), removed -> {});
                        return null;
                    });
        }

        void remove() {
            rooms.execute(
                    state,
                    operation -> {
                        operation.remove();
                        return null;
                    });
        }
    }

    private static final class Store implements RoomStore {
        final Map<String, RoomDirectory.StoredRoom> records = new ConcurrentHashMap<>();
        boolean failSave;
        boolean failDelete;
        boolean closed;
        String gatedRoom;
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.copyOf(records.values());
        }

        public void save(RoomDirectory.StoredRoom record) {
            if (failSave) throw new IllegalStateException("save failed");
            if (record.roomId().equals(gatedRoom)) {
                entered.countDown();
                try {
                    await(release);
                } catch (InterruptedException failure) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(failure);
                }
            }
            records.put(record.roomId(), record);
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

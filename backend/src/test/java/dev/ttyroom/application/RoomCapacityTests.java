package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.*;

import dev.ttyroom.domain.RoomControl;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.*;
import java.util.function.Function;

@Timeout(10)
class RoomCapacityTests {
    @Test
    void theFirstRoomBeyondCapacityIsRejectedWithoutInvalidatingTheExistingRoom() {
        try (var fixture = new Fixture(1, 2)) {
            var existing = fixture.rooms.create("Existing");

            var failure = catchThrowable(() -> fixture.rooms.create("Excess"));

            assertThat(failure)
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class)
                    .hasMessage("rooms capacity exhausted");
            assertThat(fixture.rooms.acceptsToken(existing.roomId(), existing.token())).isTrue();
        }
    }

    @Test
    void aFailedRoomSaveReturnsItsReservation() {
        try (var fixture = new Fixture(1, 2)) {
            fixture.store.failSave = true;

            var failure = catchThrowable(() -> fixture.rooms.create("Failed"));
            fixture.store.failSave = false;
            var accepted = fixture.rooms.create("Accepted");

            assertThat(failure).hasMessage("save failed");
            assertThat(fixture.rooms.acceptsToken(accepted.roomId(), accepted.token())).isTrue();
        }
    }

    @Test
    void failedDeletionKeepsItsSlotAndSuccessfulDeletionReleasesItOnlyOnce() {
        try (var fixture = new Fixture(1, 1)) {
            var old = fixture.workspace();
            fixture.store.failDelete = true;

            var deletionFailure = catchThrowable(old::remove);
            var stillFull = catchThrowable(() -> fixture.rooms.create("Excess"));
            fixture.store.failDelete = false;
            old.remove();
            old.remove();
            fixture.workspace();
            var secondExcess = catchThrowable(() -> fixture.rooms.create("Excess"));

            assertThat(deletionFailure).hasMessage("delete failed");
            assertThat(stillFull).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(secondExcess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
        }
    }

    @Test
    void terminalCapacityIsSharedAcrossRoomsAndAFailedSaveDoesNotConsumeIt() {
        try (var fixture = new Fixture(2, 1)) {
            var first = fixture.workspace();
            var second = fixture.workspace();
            fixture.store.failSave = true;

            var failedSave = catchThrowable(first::open);
            fixture.store.failSave = false;
            second.open();
            var excess = catchThrowable(first::open);

            assertThat(failedSave).hasMessage("save failed");
            assertThat(excess)
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class)
                    .hasMessage("terminals capacity exhausted");
            assertThat(first.count()).isZero();
            assertThat(second.count()).isEqualTo(1);
        }
    }

    @Test
    void anExitedTerminalStillOwnsHistoryCapacityUntilItsHostIsRemoved() {
        try (var fixture = new Fixture(2, 1)) {
            var first = fixture.workspace();
            var second = fixture.workspace();
            long terminal = first.open();

            first.change(control -> control.terminalExited("host", terminal, 0.0));
            var excess = catchThrowable(second::open);
            first.change(control -> control.removeHost("host"));
            second.open();

            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(first.count()).isZero();
            assertThat(second.count()).isEqualTo(1);
        }
    }

    @Test
    void failedHostRemovalKeepsTerminalCapacityUntilTheRemovalIsSaved() {
        try (var fixture = new Fixture(2, 1)) {
            var first = fixture.workspace();
            var second = fixture.workspace();
            first.open();
            fixture.store.failSave = true;

            var failure = catchThrowable(() -> first.change(control -> control.removeHost("host")));
            fixture.store.failSave = false;
            var excess = catchThrowable(second::open);
            first.remove();
            second.open();

            assertThat(failure).hasMessage("save failed");
            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(second.count()).isEqualTo(1);
        }
    }

    @Test
    void twoSimultaneousRoomCreationsCannotBothClaimTheLastSlot() throws Exception {
        try (var fixture = new Fixture(1, 1);
                var workers = Executors.newFixedThreadPool(2)) {
            var start = new CountDownLatch(1);
            var a =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(() -> fixture.rooms.create("A"));
                            });
            var b =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(() -> fixture.rooms.create("B"));
                            });

            start.countDown();
            var failures =
                    java.util.Arrays.asList(a.get(3, TimeUnit.SECONDS), b.get(3, TimeUnit.SECONDS));

            assertThat(failures)
                    .filteredOn(java.util.Objects::nonNull)
                    .singleElement()
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class);
        }
    }

    @Test
    void twoRoomsCannotBothClaimTheLastTerminalSlot() throws Exception {
        try (var fixture = new Fixture(2, 1);
                var workers = Executors.newFixedThreadPool(2)) {
            var first = fixture.workspace();
            var second = fixture.workspace();
            var start = new CountDownLatch(1);

            var a =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(first::open);
                            });
            var b =
                    workers.submit(
                            () -> {
                                await(start);
                                return catchThrowable(second::open);
                            });
            start.countDown();
            var failures =
                    java.util.Arrays.asList(a.get(3, TimeUnit.SECONDS), b.get(3, TimeUnit.SECONDS));

            assertThat(failures)
                    .filteredOn(java.util.Objects::nonNull)
                    .singleElement()
                    .isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(first.count() + second.count()).isEqualTo(1);
        }
    }

    @Test
    void anotherRoomRejectsGrowthWhileTheLastSlotIsWaitingForStorage() throws Exception {
        try (var fixture = new Fixture(2, 1);
                var worker = Executors.newSingleThreadExecutor()) {
            var first = fixture.workspace();
            var second = fixture.workspace();
            fixture.store.gatedRoom = first.state.id;

            var opening = worker.submit(first::open);
            await(fixture.store.entered);
            Throwable excess;
            try {
                excess = catchThrowable(second::open);
            } finally {
                fixture.store.release.countDown();
            }
            opening.get(3, TimeUnit.SECONDS);

            assertThat(excess).isInstanceOf(RoomDirectory.CapacityExceeded.class);
            assertThat(first.count()).isEqualTo(1);
            assertThat(second.count()).isZero();
        }
    }

    @Test
    void restoredCapacityOverTheConfiguredLimitFailsStartupAndClosesTheStore() {
        RoomDirectory.StoredRoom saved;
        try (var fixture = new Fixture(1, 2)) {
            var room = fixture.workspace();
            room.open();
            room.open();
            saved = room.state.durableState();
        }
        var store = new Store();
        store.saved = List.of(saved);

        var failure =
                catchThrowable(() -> new RoomDirectory(store, new RoomDirectory.Limits(1, 1)));

        assertThat(failure).isInstanceOf(RoomDirectory.CapacityExceeded.class);
        assertThat(store.closed).isTrue();
    }

    private static void await(CountDownLatch latch) throws InterruptedException {
        if (!latch.await(3, TimeUnit.SECONDS))
            throw new AssertionError("Capacity gate did not complete");
    }

    private static final class Fixture implements AutoCloseable {
        final Store store = new Store();
        final RoomDirectory rooms;

        Fixture(int rooms, int terminals) {
            this.rooms = new RoomDirectory(store, new RoomDirectory.Limits(rooms, terminals));
        }

        Workspace workspace() {
            var invitation = rooms.create("Workspace");
            var workspace =
                    new Workspace(
                            rooms,
                            rooms.authenticatedRoom(invitation.roomId(), invitation.token()));
            workspace.change(
                    control -> {
                        control.rememberHost("host", "Host");
                        return null;
                    });
            return workspace;
        }

        public void close() {
            store.release.countDown();
            rooms.close();
        }
    }

    private record Workspace(RoomDirectory rooms, RoomDirectory.Room state) {
        <T> T change(Function<RoomControl, T> action) {
            return rooms.execute(
                    state,
                    operation -> operation.changeIf(() -> true, action, Function.identity()));
        }

        long open() {
            return change(control -> control.openTerminal("host")).terminalId();
        }

        int count() {
            return state.control.terminals().size();
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
        boolean failSave;
        boolean failDelete;
        boolean closed;
        List<RoomDirectory.StoredRoom> saved = List.of();
        String gatedRoom;
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);

        public List<RoomDirectory.StoredRoom> loadAll() {
            return saved;
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (failSave) throw new IllegalStateException("save failed");
            if (room.roomId().equals(gatedRoom)) {
                entered.countDown();
                try {
                    await(release);
                } catch (InterruptedException e) {
                    throw new IllegalStateException(e);
                }
            }
        }

        public void delete(String id) {
            if (failDelete) throw new IllegalStateException("delete failed");
        }

        public void close() {
            closed = true;
        }
    }
}

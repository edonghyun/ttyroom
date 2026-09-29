package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

class RoomCredentialPersistenceTests {
    @Test
    void failedIssuanceReturnsNoCredentialAndKeepsThePreviousAuthenticationState() {
        try (var fixture = new SavedRoom()) {
            var existing = fixture.issue(RoomCredentials.Role.PARTICIPANT);
            var before = fixture.room.durableState();
            var result = new AtomicReference<RoomCredentials.Issued>();
            fixture.store.rejectWrites = true;

            var failure =
                    catchThrowable(() -> result.set(fixture.issue(RoomCredentials.Role.HOST)));
            var retained = fixture.authenticate(existing.secret());

            assertThat(failure).isSameAs(fixture.store.failure);
            assertThat(result.get()).isNull();
            assertThat(fixture.room.durableState()).isEqualTo(before);
            assertThat(fixture.store.saved).isEqualTo(before);
            assertThat(retained).contains(existing.subject());
        }
    }

    @Test
    void failedRevocationKeepsTheCredentialUsableUntilAStoredRetrySucceeds() {
        try (var fixture = new SavedRoom()) {
            var alice = fixture.issue(RoomCredentials.Role.PARTICIPANT);
            var bob = fixture.issue(RoomCredentials.Role.HOST);
            var before = fixture.room.durableState();
            fixture.store.rejectWrites = true;

            var failure = catchThrowable(() -> fixture.revoke(alice));
            var afterFailure = fixture.authenticate(alice.secret());
            var savedAfterFailure = fixture.store.saved;
            fixture.store.rejectWrites = false;
            fixture.revoke(alice);
            var afterRetry = fixture.authenticate(alice.secret());
            var retained = fixture.authenticate(bob.secret());

            assertThat(failure).isSameAs(fixture.store.failure);
            assertThat(afterFailure).contains(alice.subject());
            assertThat(savedAfterFailure).isEqualTo(before);
            assertThat(afterRetry).isEmpty();
            assertThat(retained).contains(bob.subject());
        }
    }

    @Test
    void revocationIsInvisibleUntilThePendingSaveCompletes() throws Exception {
        try (var fixture = new SavedRoom();
                var workers = Executors.newSingleThreadExecutor()) {
            var issued = fixture.issue(RoomCredentials.Role.HOST);
            var before = fixture.room.durableState();
            fixture.store.gate = new SaveGate();

            var revocation = workers.submit(() -> fixture.revoke(issued));
            Optional<RoomCredentials.Subject> duringSave;
            RoomDirectory.StoredRoom visibleDuringSave;
            boolean returnedDuringSave;
            try {
                fixture.store.gate.awaitEntered();
                duringSave = fixture.authenticate(issued.secret());
                visibleDuringSave = fixture.room.durableState();
                returnedDuringSave = revocation.isDone();
            } finally {
                fixture.store.gate.release.countDown();
            }
            revocation.get(5, TimeUnit.SECONDS);
            var afterSave = fixture.authenticate(issued.secret());

            assertThat(duringSave).contains(issued.subject());
            assertThat(visibleDuringSave).isEqualTo(before);
            assertThat(returnedDuringSave).isFalse();
            assertThat(afterSave).isEmpty();
        }
    }

    @Test
    void repeatedRevocationDoesNotWriteAndLeavesOtherCredentialsUsable() {
        try (var fixture = new SavedRoom()) {
            var alice = fixture.issue(RoomCredentials.Role.PARTICIPANT);
            var bob = fixture.issue(RoomCredentials.Role.HOST);
            fixture.revoke(alice);
            var savesBefore = fixture.store.saves;

            fixture.revoke(alice);
            var retained = fixture.authenticate(bob.secret());

            assertThat(fixture.store.saves).isEqualTo(savesBefore);
            assertThat(retained).contains(bob.subject());
        }
    }

    @Test
    void deletedRoomsCannotAuthenticateOrBeResurrectedByIssuance() {
        try (var fixture = new SavedRoom()) {
            var issued = fixture.issue(RoomCredentials.Role.HOST);
            fixture.rooms.execute(
                    fixture.room,
                    operation -> {
                        operation.remove();
                        return null;
                    });

            var authenticated = fixture.authenticate(issued.secret());
            var failure = catchThrowable(() -> fixture.issue(RoomCredentials.Role.HOST));

            assertThat(authenticated).isEmpty();
            assertThat(failure).isInstanceOf(IllegalStateException.class);
            assertThat(fixture.store.saved).isNull();
        }
    }

    private static final class SaveGate {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);

        void awaitEntered() throws InterruptedException {
            if (!entered.await(5, TimeUnit.SECONDS))
                throw new IllegalStateException("Credential save did not start");
        }

        void waitForRelease() {
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS))
                    throw new IllegalStateException("Credential save was not released");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
        }
    }

    private static final class SavedRoom implements AutoCloseable {
        final RecordingStore store = new RecordingStore();
        final RoomDirectory rooms = new RoomDirectory(store);
        final RoomDirectory.Room room;

        SavedRoom() {
            var invitation = rooms.create("Credential tests");
            room = rooms.authenticatedRoom(invitation.roomId(), invitation.token());
        }

        RoomCredentials.Issued issue(RoomCredentials.Role role) {
            return rooms.issueCredential(room, role);
        }

        void revoke(RoomCredentials.Issued issued) {
            rooms.revokeCredential(room, issued.subject().id());
        }

        Optional<RoomCredentials.Subject> authenticate(String secret) {
            return rooms.authenticateCredential(room, secret);
        }

        @Override
        public void close() {
            rooms.close();
        }
    }

    private static final class RecordingStore implements RoomStore {
        final IllegalStateException failure = new IllegalStateException("Controlled save failure");
        RoomDirectory.StoredRoom saved;
        boolean rejectWrites;
        int saves;
        SaveGate gate;

        public List<RoomDirectory.StoredRoom> loadAll() {
            return saved == null ? List.of() : List.of(saved);
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (gate != null) gate.waitForRelease();
            if (rejectWrites) throw failure;
            saves++;
            saved = room;
        }

        public void delete(String roomId) {
            saved = null;
        }

        public void close() {}
    }
}

package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import dev.ttyroom.adapter.sqlite.SqliteRoomStore;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

class RoomRegistrationStorageTests {
    @TempDir Path directory;

    @Test
    void managerAuthoritySurvivesAFileReopenWithoutStoringTheSecret() {
        var file = directory.resolve("registration.sqlite");
        RoomDirectory.Invitation invitation;
        RoomCredentials.Issued participant;
        try (var rooms = new RoomDirectory(new SqliteRoomStore(file))) {
            invitation = rooms.create("Registered room");
            participant = rooms.registerParticipant(invitation.roomId(), invitation.token());
        }

        var store = new SqliteRoomStore(file);
        try (var rooms = new RoomDirectory(store)) {
            var host = rooms.registerHost(invitation.roomId(), invitation.managerCredential());
            var room = rooms.authenticatedRoom(invitation.roomId(), invitation.token());
            var retained = rooms.authenticateCredential(room, participant.secret());
            var records = store.loadAll().getFirst().credentials();

            assertThat(host.subject().role()).isEqualTo(RoomCredentials.Role.HOST);
            assertThat(retained).contains(participant.subject());
            assertThat(records)
                    .extracting(record -> record.subject().role())
                    .containsExactly(
                            RoomCredentials.Role.MANAGER,
                            RoomCredentials.Role.PARTICIPANT,
                            RoomCredentials.Role.HOST);
            assertThat(records)
                    .extracting(RoomCredentials.Stored::digest)
                    .doesNotContain(
                            invitation.managerCredential(), participant.secret(), host.secret());
            assertThat(invitation.toString())
                    .doesNotContain(invitation.managerCredential(), invitation.token());
        }
    }

    @Test
    void revokingManagerAuthorityPreventsFurtherHostRegistration() {
        try (var rooms = new RoomDirectory()) {
            var invitation = rooms.create("Managed room");
            var room = rooms.authenticatedRoom(invitation.roomId(), invitation.token());
            var manager =
                    rooms.authenticateCredential(room, invitation.managerCredential())
                            .orElseThrow();
            rooms.revokeCredential(room, manager.id());
            var before = room.durableState();

            var failure =
                    catchThrowable(
                            () ->
                                    rooms.registerHost(
                                            invitation.roomId(), invitation.managerCredential()));

            assertThat(failure).isInstanceOf(RoomDirectory.RegistrationRejected.class);
            assertThat(room.durableState()).isEqualTo(before);
        }
    }

    @Test
    void legacyRoomsDoNotGainManagerAuthorityFromAnInvitation() {
        RoomDirectory.Invitation invitation;
        RoomDirectory.StoredRoom legacy;
        try (var original = new RoomDirectory()) {
            invitation = original.create("Legacy room");
            var record =
                    original.authenticatedRoom(invitation.roomId(), invitation.token())
                            .durableState();
            legacy =
                    new RoomDirectory.StoredRoom(
                            record.roomId(), record.name(), record.tokenHash(), record.control());
        }
        try (var restored = new RoomDirectory(List.of(legacy))) {
            var failure =
                    catchThrowable(
                            () -> restored.registerHost(invitation.roomId(), invitation.token()));
            var restoredRoom = restored.authenticatedRoom(invitation.roomId(), invitation.token());

            assertThat(failure).isInstanceOf(RoomDirectory.RegistrationRejected.class);
            assertThat(restoredRoom.durableState().credentials()).isEmpty();
        }
    }
}

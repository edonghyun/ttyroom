package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

class RoomDirectoryTests {
    @Test
    void restoredRoomAcceptsTheOriginalInvitationUsingOnlyItsDigest() throws Exception {
        var original = new RoomDirectory();
        var invitation = original.create("Workspace");
        var saved =
                original.authenticatedRoom(invitation.roomId(), invitation.token()).durableState();
        var expectedHash =
                HexFormat.of()
                        .formatHex(
                                MessageDigest.getInstance("SHA-256")
                                        .digest(
                                                invitation
                                                        .token()
                                                        .getBytes(StandardCharsets.UTF_8)));

        var restored = new RoomDirectory(List.of(saved));
        var room = restored.authenticatedRoom(invitation.roomId(), invitation.token());

        assertThat(saved.tokenHash()).isEqualTo(expectedHash);
        assertThat(saved.toString()).doesNotContain(invitation.token(), expectedHash);
        assertThat(room.name).isEqualTo("Workspace");
        assertThat(room.durableState()).isEqualTo(saved);
        assertThat(restored.acceptsToken(invitation.roomId(), "invalid")).isFalse();
        assertThat(restored.acceptsToken("missing", invitation.token())).isFalse();
    }

    @Test
    void duplicateRoomIdentityFailsBootstrapInsteadOfSilentlyReplacingAWorkspace() {
        var original = new RoomDirectory();
        var invitation = original.create("Workspace");
        var saved =
                original.authenticatedRoom(invitation.roomId(), invitation.token()).durableState();

        var failure = catchThrowable(() -> new RoomDirectory(List.of(saved, saved)));

        assertThat(failure)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Duplicate room ID");
    }

    @Test
    void malformedDigestCannotBecomeAStoredInvitation() {
        var original = new RoomDirectory();
        var invitation = original.create("Workspace");
        var saved =
                original.authenticatedRoom(invitation.roomId(), invitation.token()).durableState();

        var failure =
                catchThrowable(
                        () ->
                                new RoomDirectory.StoredRoom(
                                        saved.roomId(),
                                        saved.name(),
                                        invitation.token(),
                                        saved.control()));

        assertThat(failure)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Invalid invitation digest");
    }

    @Test
    void onlyTheMatchingRoomsInvitationAuthenticates() {
        var rooms = new RoomDirectory();
        var first = rooms.create(null);
        var second = rooms.create("Second");

        assertThat(rooms.acceptsToken(first.roomId(), first.token())).isTrue();
        assertThat(rooms.acceptsToken(first.roomId(), second.token())).isFalse();
        assertThat(rooms.acceptsToken(first.roomId(), "invalid")).isFalse();
        assertThat(rooms.acceptsToken("missing", first.token())).isFalse();
        assertThat(first.toString()).doesNotContain(first.token());
    }
}

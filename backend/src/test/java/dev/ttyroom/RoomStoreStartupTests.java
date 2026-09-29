package dev.ttyroom;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import dev.ttyroom.application.RoomDirectory;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;

@ExtendWith(OutputCaptureExtension.class)
class RoomStoreStartupTests {
    @TempDir Path directory;

    @Test
    void configuredStatePathRestoresTheInvitationInANewApplication() {
        var file = directory.resolve("state/rooms.sqlite");
        RoomDirectory.Invitation invitation;
        try (var application = startApplication(file.toString())) {
            invitation = application.getBean(RoomDirectory.class).create("Saved room");
        }

        try (var restarted = startApplication(file.toString())) {
            var accepted =
                    restarted
                            .getBean(RoomDirectory.class)
                            .acceptsToken(invitation.roomId(), invitation.token());

            assertThat(accepted).isTrue();
        }
    }

    @Test
    void emptyStatePathKeepsRoomsOnlyForTheApplicationLifetime() {
        RoomDirectory.Invitation invitation;
        try (var application = startApplication("")) {
            invitation = application.getBean(RoomDirectory.class).create("Temporary room");
        }

        try (var restarted = startApplication("")) {
            var accepted =
                    restarted
                            .getBean(RoomDirectory.class)
                            .acceptsToken(invitation.roomId(), invitation.token());

            assertThat(accepted).isFalse();
        }
    }

    @Test
    void unusableStatePathFailsStartupWithoutAnnouncingReadiness(CapturedOutput output)
            throws Exception {
        var parentFile = directory.resolve("not-a-directory");
        Files.writeString(parentFile, "occupied");

        var failure =
                catchThrowable(
                        () -> {
                            try (var ignored =
                                    startApplication(
                                            parentFile.resolve("rooms.sqlite").toString())) {}
                        });

        assertThat(failure).hasStackTraceContaining("Cannot open SQLite room store");
        assertThat(output.getAll()).doesNotContain("TTYRoom server listening at");
    }

    @Test
    void corruptStoredRoomFailsStartupWithoutAnnouncingReadiness(CapturedOutput output)
            throws Exception {
        var file = directory.resolve("corrupt.sqlite");
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                var statement = connection.createStatement()) {
            statement.execute(
                    "CREATE TABLE rooms(room_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)"
                            + " STRICT");
            statement.execute("INSERT INTO rooms VALUES ('broken-room', '{}')");
        }

        var failure =
                catchThrowable(
                        () -> {
                            try (var ignored = startApplication(file.toString())) {}
                        });

        assertThat(failure).hasRootCauseMessage("Invalid stored room record");
        assertThat(output.getAll()).doesNotContain("TTYRoom server listening at");
    }

    private ConfigurableApplicationContext startApplication(String statePath) {
        return new SpringApplicationBuilder(TtyRoomApplication.class)
                .registerShutdownHook(false)
                .run("--server.port=0", "--TTYROOM_STATE_PATH=" + statePath);
    }
}

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
import org.springframework.boot.web.server.context.WebServerApplicationContext;

import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

@ExtendWith(OutputCaptureExtension.class)
class ServerSettingsStartupTests {
    @TempDir Path directory;

    @Test
    void explicitFileSelectsTheActualListeningPortAndPersistentStore() throws Exception {
        var database = directory.resolve("from-file.sqlite");
        var config = configuration(Map.of("port", 0, "statePath", database.toString()));

        try (var application =
                new SpringApplicationBuilder(TtyRoomApplication.class)
                        .registerShutdownHook(false)
                        .run("--TTYROOM_CONFIG_PATH=" + config)) {
            application.getBean(RoomDirectory.class).create("From configuration");
            var port = ((WebServerApplicationContext) application).getWebServer().getPort();

            assertThat(port).isPositive().isNotEqualTo(3000);
            assertThat(database).exists();
        }
    }

    @Test
    void invalidConfigurationFailsBeforeOpeningTheStoreOrAnnouncingReadiness(CapturedOutput output)
            throws Exception {
        var database = directory.resolve("must-not-exist.sqlite");
        var config =
                configuration(
                        Map.of(
                                "statePath",
                                database.toString(),
                                "policy",
                                Map.of("hostGraceMs", -1)));

        var failure =
                catchThrowable(
                        () -> {
                            try (var ignored =
                                    new SpringApplicationBuilder(TtyRoomApplication.class)
                                            .registerShutdownHook(false)
                                            .run("--TTYROOM_CONFIG_PATH=" + config)) {}
                        });

        assertThat(failure).hasRootCauseMessage("Invalid TTYRoom setting: hostGraceMs");
        assertThat(database).doesNotExist();
        assertThat(output.getAll()).doesNotContain("TTYRoom server listening at");
    }

    private Path configuration(Map<String, Object> values) throws Exception {
        var file = directory.resolve("explicit-settings.json");
        Files.writeString(file, JsonMapper.builder().build().writeValueAsString(values));
        return file;
    }
}

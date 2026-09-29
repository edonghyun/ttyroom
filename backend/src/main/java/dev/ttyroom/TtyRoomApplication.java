package dev.ttyroom;

import dev.ttyroom.adapter.config.ServerSettings;
import dev.ttyroom.adapter.sqlite.SqliteRoomStore;
import dev.ttyroom.adapter.ws.RoomSocketHandler;
import dev.ttyroom.application.RoomDirectory;
import dev.ttyroom.application.RoomSessions;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.server.ConfigurableWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;

import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;

@SpringBootApplication
public class TtyRoomApplication {
    public static void main(String[] args) {
        SpringApplication.run(TtyRoomApplication.class, args);
    }

    @Bean
    ServerSettings serverSettings(Environment environment) {
        return ServerSettings.load(environment);
    }

    @Bean
    WebServerFactoryCustomizer<ConfigurableWebServerFactory> serverPort(ServerSettings settings) {
        return factory -> factory.setPort(settings.port());
    }

    @Bean
    RoomDirectory roomDirectory(ServerSettings settings) {
        var statePath = settings.statePath();
        return statePath.isEmpty()
                ? new RoomDirectory()
                : new RoomDirectory(new SqliteRoomStore(Path.of(statePath)));
    }

    @Bean
    RoomSessions roomSessions(RoomDirectory rooms, ServerSettings settings) {
        return new RoomSessions(
                rooms,
                new RoomSessions.Policy(
                        settings.participantGraceMs(),
                        settings.hostGraceMs(),
                        settings.scrollbackBytesPerTerminal()));
    }

    @Bean
    RoomSocketHandler roomSocketHandler(
            RoomSessions sessions, JsonMapper json, ServerSettings settings) {
        return new RoomSocketHandler(
                sessions,
                json,
                new RoomSocketHandler.Limits(
                        settings.sendBufferDropThresholdBytes(),
                        settings.maxQueuedDataBytesPerConnection()));
    }

    // Public process-runner contract; announce only after application initialization finishes.
    @EventListener(ApplicationReadyEvent.class)
    public void announceReady(ApplicationReadyEvent event) {
        var context = (WebServerApplicationContext) event.getApplicationContext();
        System.out.println(
                "TTYRoom server listening at http://127.0.0.1:" + context.getWebServer().getPort());
    }
}

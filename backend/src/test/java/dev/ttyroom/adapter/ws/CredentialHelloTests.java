package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.json.JsonMapper;

class CredentialHelloTests {
    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void v8HelloCarriesOnlyTheCredentialRoomAndDisplayName() {
        var message =
                json.readTree(
                        """
                        {"type":"hello","protocolVersion":8,"roomId":"room",
                         "credential":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"Alice"}
                        """);

        var hello = RoomProtocol.hello(message);

        assertThat(hello).isNotNull();
        assertThat(hello.toString()).doesNotContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }

    @Test
    void legacyHelloKeepsItsExistingUnknownFieldCompatibility() {
        var message =
                json.readTree(
                        """
                        {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                         "clientId":"alice","role":"participant","name":"Alice","credential":"ignored"}
                        """);

        var hello = RoomProtocol.hello(message);

        assertThat(hello).isInstanceOf(dev.ttyroom.application.RoomSessions.Hello.class);
    }

    @Test
    void legacyShapedHelloKeepsItsVersionForTheAdmissionGate() {
        var message =
                json.readTree(
                        """
                        {"type":"hello","protocolVersion":8,"roomId":"room","token":"invalid",
                         "clientId":"alice","role":"participant","name":"Alice"}
                        """);

        var hello = RoomProtocol.hello(message);

        assertThat(hello).isInstanceOf(dev.ttyroom.application.RoomSessions.Hello.class);
        assertThat(hello.protocolVersion()).isEqualTo(8);
    }

    @ParameterizedTest
    @ValueSource(strings = {"role", "clientId", "participantId", "hostId", "token"})
    void v8HelloRejectsClientSelectedAuthorityInsteadOfIgnoringIt(String field) {
        var message =
                json.createObjectNode()
                        .put("type", "hello")
                        .put("protocolVersion", 8)
                        .put("roomId", "room")
                        .put("credential", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                        .put("name", "Alice")
                        .put(field, "chosen");

        var hello = RoomProtocol.hello(message);

        assertThat(hello).isNull();
    }
}

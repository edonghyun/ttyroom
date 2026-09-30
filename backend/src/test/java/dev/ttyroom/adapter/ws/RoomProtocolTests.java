package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;

import dev.ttyroom.application.CursorPosition;
import dev.ttyroom.application.HostCommand;
import dev.ttyroom.application.ParticipantCommand;
import dev.ttyroom.application.RoomNotice;
import dev.ttyroom.application.RoomNotice.*;
import dev.ttyroom.domain.HostPresence;
import dev.ttyroom.domain.LeaseControl;
import dev.ttyroom.domain.RoomControl.InputRejection;
import dev.ttyroom.domain.TerminalWorkspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.stream.Stream;

class RoomProtocolTests {
    @Test
    void credentialHelloMatchesTheSharedV8DocumentationExample() throws Exception {
        var example = credentialWireExample("credential-hello");

        var decoded = RoomProtocol.hello(example);

        assertThat(decoded)
                .isEqualTo(
                        new dev.ttyroom.application.RoomSessions.CredentialHello(
                                8,
                                example.path("roomId").asString(),
                                example.path("credential").asString(),
                                example.path("name").asString()));
    }

    @Test
    void credentialRejectionMatchesTheSharedV8DocumentationExample() throws Exception {
        var example = credentialWireExample("invalid-credential");
        var json = JsonMapper.builder().build();

        var encoded =
                json.readTree(
                        json.writeValueAsString(
                                RoomProtocol.encode(
                                        new Rejected("invalid-credential", "invalid-credential"))));

        assertThat(encoded).isEqualTo(example);
    }

    private static JsonNode credentialWireExample(String name) throws Exception {
        try (var input = RoomProtocolTests.class.getResourceAsStream("/protocol/wire-v8.json")) {
            if (input == null) throw new IllegalStateException("v8 wire fixture missing");
            return JsonMapper.builder().build().readTree(input).path(name);
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("notices")
    void matchesTheSharedProtocolV7Fixture(String fixtureName, RoomNotice notice) throws Exception {
        var json = JsonMapper.builder().build();
        var expected = expectedMessage(fixtureName, json);

        var encoded = json.readTree(json.writeValueAsString(RoomProtocol.encode(notice)));

        assertWireEquals(encoded, expected);
    }

    static Stream<Arguments> notices() {
        return Stream.of(
                Arguments.of(
                        "server-welcome-18",
                        new Welcome(
                                "r1",
                                "Payment Debug",
                                "c1",
                                List.of(),
                                List.of(),
                                List.of(),
                                List.of())),
                Arguments.of(
                        "server-room-event-31",
                        new ParticipantJoined(new Participant("c2", "민수", null))),
                Arguments.of("server-room-event-32", new ParticipantLeft("c2")),
                Arguments.of("server-room-event-33", new ParticipantFocusChanged("c2", 3L)),
                Arguments.of(
                        "server-participant-cursor-20",
                        new ParticipantCursor("c2", new CursorPosition(120.5, 80))),
                Arguments.of(
                        "server-room-event-40",
                        new TerminalGeometryChanged(
                                3, new TerminalWorkspace.Geometry(120, 80, 720, 480))),
                Arguments.of("server-room-event-41", new TerminalRenamed(3, "API logs")),
                Arguments.of("server-room-event-35", new HostOffline("h1")),
                Arguments.of("server-room-event-36", new HostRemoved("h1")),
                Arguments.of("server-error-26", new Rejected("invalid-token", "token mismatch")),
                Arguments.of(
                        "server-room-event-34",
                        new HostConnected(new HostPresence.State("h1", "dev-server", true, true))),
                Arguments.of("server-room-event-37", new HostInputStateChanged("h1", false)),
                Arguments.of(
                        "server-host-ready-30", new HostReady(List.of(new ReplayPosition(3, 5)))),
                Arguments.of("server-lease-result-21", new LeaseAccepted(3, 7)),
                Arguments.of(
                        "server-lease-invalid-22",
                        new LeaseInvalid(3, InputRejection.REMOTE_INPUT_DISABLED)),
                Arguments.of(
                        "server-room-event-43",
                        new LeaseGranted(new LeaseControl.Lease(3, 7, "c1"))),
                Arguments.of("server-room-event-44", new LeaseReleased(3)),
                Arguments.of("server-sync-24", new Sync(3, 10)),
                Arguments.of(
                        "server-room-event-45",
                        new TerminalMetadataChanged(
                                3, new TerminalWorkspace.Metadata("/home/kep", null, null))),
                Arguments.of("server-output-gap-25", new OutputGap(3, 11, 42)),
                Arguments.of("server-close-terminal-28", new CloseTerminal(3)),
                Arguments.of("server-resize-29", new ResizeTerminal(3, 120, 40)),
                Arguments.of("server-open-terminal-27", new OpenTerminal(3)),
                Arguments.of(
                        "server-room-event-39",
                        new TerminalModeChanged(3, TerminalWorkspace.Mode.SHARED)));
    }

    @Test
    void inventoryPreservesUnsigned32BitIdsAndSequenceNumbers() {
        var json = JsonMapper.builder().build();
        var message =
                json.readTree(
                        """
                        {"type":"host-inventory","terminals":[{"terminalId":4294967295,
                         "runtimeId":"runtime","firstRetainedSeq":0,"lastOutputSeq":4294967295}]}
                        """);

        var command = RoomProtocol.hostCommand(message);

        assertThat(command)
                .isEqualTo(
                        new HostCommand.Inventory(
                                List.of(
                                        new HostCommand.Runtime(
                                                4294967295L, "runtime", 0, 4294967295L))));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {"{}", "{\"exitCode\":1.5}", "{\"exitCode\":\"7\"}", "{\"exitCode\":1e309}"})
    void malformedExitCodesAreRejectedBeforeChangingTerminalState(String fields) {
        var json = JsonMapper.builder().build();
        var message = json.createObjectNode();
        message.put("type", "terminal-closed");
        message.put("terminalId", 1);
        var exitCode = json.readTree(fields).get("exitCode");
        if (exitCode != null) message.set("exitCode", exitCode);

        assertThat(RoomProtocol.hostCommand(message)).isNull();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "{\"type\":\"acquire-lease\"}",
                "{\"type\":\"acquire-lease\",\"terminalId\":-1}",
                "{\"type\":\"acquire-lease\",\"terminalId\":1.5}",
                "{\"type\":\"release-lease\",\"terminalId\":7}",
                "{\"type\":\"release-lease\",\"terminalId\":7,\"leaseId\":4294967296}",
                "{\"type\":\"release-lease\",\"terminalId\":7,\"leaseId\":\"1\"}"
            })
    void invalidLeaseCommandsAreRejectedBeforeDispatch(String raw) {
        assertThat(RoomProtocol.participantCommand(JsonMapper.builder().build().readTree(raw)))
                .isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"exclusive", "shared"})
    void modeCommandPreservesUnsignedTerminalId(String mode) {
        var raw =
                "{\"type\":\"set-terminal-mode\",\"terminalId\":4294967295,\"mode\":\""
                        + mode
                        + "\"}";

        var command = RoomProtocol.participantCommand(JsonMapper.builder().build().readTree(raw));

        assertThat(command)
                .isEqualTo(
                        new ParticipantCommand.SetTerminalMode(
                                4294967295L,
                                mode.equals("shared")
                                        ? TerminalWorkspace.Mode.SHARED
                                        : TerminalWorkspace.Mode.EXCLUSIVE));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "{}",
                "{\"terminalId\":7}",
                "{\"terminalId\":7,\"mode\":null}",
                "{\"terminalId\":7,\"mode\":true}",
                "{\"terminalId\":7,\"mode\":\"SHARED\"}",
                "{\"terminalId\":4294967296,\"mode\":\"shared\"}",
                "{\"terminalId\":1.5,\"mode\":\"shared\"}",
                "{\"terminalId\":\"7\",\"mode\":\"shared\"}"
            })
    void malformedModeCommandsAreRejectedBeforeDispatch(String fields) {
        var json = JsonMapper.builder().build();
        var message = json.createObjectNode();
        message.put("type", "set-terminal-mode");
        var supplied = json.readTree(fields);
        if (supplied.has("terminalId")) message.set("terminalId", supplied.get("terminalId"));
        if (supplied.has("mode")) message.set("mode", supplied.get("mode"));

        assertThat(RoomProtocol.participantCommand(message)).isNull();
    }

    @Test
    void terminalControlCommandsPreserveUnsignedIdAndDimensionBoundaries() {
        var json = JsonMapper.builder().build();

        var close =
                RoomProtocol.participantCommand(
                        json.readTree(
                                "{\"type\":\"close-terminal-request\",\"terminalId\":4294967295}"));
        var resize =
                RoomProtocol.participantCommand(
                        json.readTree(
                                "{\"type\":\"resize-request\",\"terminalId\":4294967295,\"cols\":1,\"rows\":65535}"));

        assertThat(close).isEqualTo(new ParticipantCommand.CloseTerminal(4294967295L));
        assertThat(resize).isEqualTo(new ParticipantCommand.ResizeTerminal(4294967295L, 1, 65535));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "{\"type\":\"close-terminal-request\"}",
                "{\"type\":\"close-terminal-request\",\"terminalId\":-1}",
                "{\"type\":\"close-terminal-request\",\"terminalId\":4294967296}",
                "{\"type\":\"resize-request\",\"terminalId\":7,\"cols\":80}",
                "{\"type\":\"resize-request\",\"terminalId\":7,\"cols\":0,\"rows\":24}",
                "{\"type\":\"resize-request\",\"terminalId\":7,\"cols\":80,\"rows\":65536}",
                "{\"type\":\"resize-request\",\"terminalId\":7,\"cols\":1.5,\"rows\":24}",
                "{\"type\":\"resize-request\",\"terminalId\":7,\"cols\":80,\"rows\":null}",
                "{\"type\":\"resize-request\",\"terminalId\":7,\"cols\":\"80\",\"rows\":24}",
                "{\"type\":\"resize-request\",\"terminalId\":\"7\",\"cols\":80,\"rows\":24}"
            })
    void malformedTerminalControlsAreRejectedBeforeDispatch(String raw) {
        assertThat(RoomProtocol.participantCommand(JsonMapper.builder().build().readTree(raw)))
                .isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"rename-terminal", "update-terminal-geometry"})
    void viewCommandsAcceptUnsigned32BitIds(String type) {
        var json = JsonMapper.builder().build();
        var node =
                json.readTree(
                        """
                        {"terminalId":4294967295,"title":" API ","geometry":{"x":-0.5,"y":65535,"width":0.5,"height":1}}
                        """);
        ((tools.jackson.databind.node.ObjectNode) node).put("type", type);
        ParticipantCommand expected =
                type.equals("rename-terminal")
                        ? new ParticipantCommand.RenameTerminal(0xffff_ffffL, "API")
                        : new ParticipantCommand.UpdateTerminalGeometry(
                                0xffff_ffffL, new TerminalWorkspace.Geometry(-0.5, 65535, 0.5, 1));

        assertThat(RoomProtocol.participantCommand(node)).isEqualTo(expected);
    }

    @Test
    void presenceCommandsAndNoticesPreserveExplicitNullsAndUnsignedIds() {
        var json = JsonMapper.builder().build();

        var focus =
                RoomProtocol.participantCommand(
                        json.readTree(
                                """
                                {"type":"focus-terminal","terminalId":4294967295}
                                """));
        var blur =
                RoomProtocol.participantCommand(
                        json.readTree(
                                """
                                {"type":"focus-terminal","terminalId":null}
                                """));
        var leave =
                RoomProtocol.participantCommand(
                        json.readTree(
                                """
                                {"type":"move-cursor","position":null}
                                """));

        assertThat(focus).isEqualTo(new ParticipantCommand.FocusTerminal(0xffff_ffffL));
        assertThat(blur).isEqualTo(new ParticipantCommand.FocusTerminal(null));
        assertThat(leave).isEqualTo(new ParticipantCommand.MoveCursor(null));
        assertWireEquals(
                json.valueToTree(RoomProtocol.encode(new ParticipantFocusChanged("alice", null))),
                json.readTree(
                        """
                        {"type":"room-event","event":{"kind":"participant-focus-changed","clientId":"alice","focusedTerminalId":null}}
                        """));
        assertWireEquals(
                json.valueToTree(RoomProtocol.encode(new ParticipantCursor("alice", null))),
                json.readTree(
                        """
                        {"type":"participant-cursor","clientId":"alice","position":null}
                        """));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "{\"type\":\"focus-terminal\"}",
                "{\"type\":\"focus-terminal\",\"terminalId\":-1}",
                "{\"type\":\"focus-terminal\",\"terminalId\":1.5}",
                "{\"type\":\"focus-terminal\",\"terminalId\":4294967296}",
                "{\"type\":\"move-cursor\"}",
                "{\"type\":\"move-cursor\",\"position\":{}}",
                "{\"type\":\"move-cursor\",\"position\":{\"x\":0,\"y\":null}}",
                "{\"type\":\"move-cursor\",\"position\":{\"x\":-65536,\"y\":0}}",
                "{\"type\":\"move-cursor\",\"position\":{\"x\":0,\"y\":65536}}",
                "{\"type\":\"move-cursor\",\"position\":{\"x\":1e309,\"y\":0}}"
            })
    void malformedPresenceCommandsAreRejected(String raw) {
        assertThat(RoomProtocol.participantCommand(JsonMapper.builder().build().readTree(raw)))
                .isNull();
    }

    private static void assertWireEquals(JsonNode actual, JsonNode expected) {
        // Protocol JSON numbers have value semantics despite Jackson's integer/double node types.
        assertThat(
                        actual.equals(
                                (left, right) -> {
                                    if (left.isNumber() && right.isNumber())
                                        return Double.compare(left.asDouble(), right.asDouble());
                                    return left.equals(right) ? 0 : 1;
                                },
                                expected))
                .withFailMessage("Expected %s but received %s", expected, actual)
                .isTrue();
    }

    private JsonNode expectedMessage(String name, JsonMapper json) throws Exception {
        try (var input = getClass().getResourceAsStream("/protocol/wire-v7.json")) {
            if (input == null) throw new AssertionError("Shared protocol fixture is missing");
            for (var message : json.readTree(input).get("messages")) {
                if (message.get("name").asString().equals(name)) return message.get("expected");
            }
            throw new AssertionError("Missing shared protocol example: " + name);
        }
    }
}

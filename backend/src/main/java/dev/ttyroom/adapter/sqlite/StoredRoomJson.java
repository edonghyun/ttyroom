package dev.ttyroom.adapter.sqlite;

import dev.ttyroom.application.RoomDirectory.StoredRoom;
import dev.ttyroom.domain.RoomControl;
import dev.ttyroom.domain.TerminalWorkspace;

import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.EnumNamingStrategies;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;

/** Owns the versioned disk representation independently of WebSocket messages. */
final class StoredRoomJson {
    private final JsonMapper json =
            JsonMapper.builder()
                    .enumNamingStrategy(EnumNamingStrategies.LowerCaseStrategy.INSTANCE)
                    .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
                    .enable(
                            DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES,
                            DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES,
                            DeserializationFeature.FAIL_ON_TRAILING_TOKENS,
                            DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .build();

    String encode(StoredRoom room) {
        return json.writeValueAsString(
                new RecordV1(
                        1,
                        room.roomId(),
                        room.name(),
                        room.tokenHash(),
                        room.control().workspace().nextTerminalId(),
                        room.control().hosts(),
                        room.control().workspace().terminals()));
    }

    StoredRoom decode(String text) {
        try {
            var root = json.readTree(text);
            // Version 1 predates geometry; only a missing field receives the legacy default.
            for (var terminal : root.path("terminals")) {
                if (terminal.path("view") instanceof ObjectNode view && !view.has("geometry"))
                    view.set(
                            "geometry",
                            json.valueToTree(new TerminalWorkspace.Geometry(24, 24, 640, 420)));
            }
            var record = json.treeToValue(root, RecordV1.class);
            return new StoredRoom(
                    record.roomId(),
                    record.name(),
                    record.tokenHash(),
                    new RoomControl.DurableState(
                            record.hosts(),
                            new TerminalWorkspace.DurableState(
                                    record.nextTerminalId(), record.terminals())));
        } catch (RuntimeException invalid) {
            // Parser exceptions can include the stored digest or terminal metadata. Do not echo
            // rows.
            throw new IllegalArgumentException("Invalid stored room record");
        }
    }

    private record RecordV1(
            int schemaVersion,
            String roomId,
            String name,
            String tokenHash,
            long nextTerminalId,
            List<RoomControl.HostIdentity> hosts,
            List<TerminalWorkspace.StoredTerminal> terminals) {
        RecordV1 {
            require(schemaVersion == 1);
            require(roomId != null && !roomId.isEmpty());
            require(name != null && !name.isEmpty());
            require(tokenHash != null && tokenHash.matches("[a-f0-9]{64}"));
            require(nextTerminalId >= 1 && nextTerminalId <= 0x1_0000_0000L);
            hosts = List.copyOf(hosts);
            terminals = List.copyOf(terminals);
            for (var host : hosts) require(!host.hostId().isEmpty());
            for (var stored : terminals) {
                var view = stored.view();
                var title = view.title().trim();
                require(!title.isEmpty() && title.length() <= 80);
                var geometry = view.geometry();
                require(coordinate(geometry.x()) && coordinate(geometry.y()));
                require(dimension(geometry.width()) && dimension(geometry.height()));
                require(
                        view.exitCode() == null
                                || (Double.isFinite(view.exitCode())
                                        && view.exitCode() == Math.rint(view.exitCode())));
                require(stored.runtimeId() == null || !stored.runtimeId().isEmpty());
            }
        }
    }

    private static boolean coordinate(double value) {
        return Double.isFinite(value) && value >= -0xffff && value <= 0xffff;
    }

    private static boolean dimension(double value) {
        return Double.isFinite(value) && value > 0 && value <= 0xffff;
    }

    private static void require(boolean valid) {
        if (!valid) throw new IllegalArgumentException("Invalid stored room record");
    }
}

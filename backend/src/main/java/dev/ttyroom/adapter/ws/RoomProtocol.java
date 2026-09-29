package dev.ttyroom.adapter.ws;

import dev.ttyroom.application.CursorPosition;
import dev.ttyroom.application.HostCommand;
import dev.ttyroom.application.ParticipantCommand;
import dev.ttyroom.application.RoomNotice;
import dev.ttyroom.application.RoomNotice.*;
import dev.ttyroom.application.RoomSessions;
import dev.ttyroom.domain.HostPresence;
import dev.ttyroom.domain.LeaseControl;
import dev.ttyroom.domain.RoomControl.TerminalRejection;
import dev.ttyroom.domain.TerminalWorkspace;

import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Validates session commands and maps session results to protocol v7. Adding a result requires an
 * explicit wire mapping.
 */
final class RoomProtocol {
    private RoomProtocol() {}

    static RoomSessions.Hello hello(JsonNode node) {
        if (node == null || !node.isObject()) return null;
        for (var key : new String[] {"type", "roomId", "token", "clientId", "name", "role"})
            if (!node.has(key) || !node.get(key).isString()) return null;
        var version = node.get("protocolVersion");
        if (!node.get("type").asString().equals("hello")
                || version == null
                || !version.isNumber()
                || !Double.isFinite(version.asDouble())
                || version.asDouble() <= 0
                || Math.floor(version.asDouble()) != version.asDouble()) return null;
        var role =
                switch (node.get("role").asString()) {
                    case "participant" -> RoomSessions.Role.PARTICIPANT;
                    case "host" -> RoomSessions.Role.HOST;
                    default -> null;
                };
        if (role == null) return null;
        return new RoomSessions.Hello(
                version.asDouble(),
                node.get("roomId").asString(),
                node.get("token").asString(),
                node.get("clientId").asString(),
                node.get("name").asString(),
                role);
    }

    static HostCommand hostCommand(JsonNode node) {
        if (node == null || !node.isObject() || !node.has("type") || !node.get("type").isString())
            return null;
        return switch (node.get("type").asString()) {
            case "host-input-state" ->
                    node.has("remoteInputAllowed") && node.get("remoteInputAllowed").isBoolean()
                            ? new HostCommand.InputState(node.get("remoteInputAllowed").asBoolean())
                            : null;
            case "host-inventory" -> inventory(node.get("terminals"));
            case "terminal-opened" ->
                    u32(node.get("terminalId"))
                                    && node.has("runtimeId")
                                    && node.get("runtimeId").isString()
                                    && !node.get("runtimeId").asString().isEmpty()
                            ? new HostCommand.TerminalOpened(
                                    node.get("terminalId").asLong(),
                                    node.get("runtimeId").asString())
                            : null;
            case "terminal-closed" ->
                    u32(node.get("terminalId")) && exitCode(node.get("exitCode"))
                            ? new HostCommand.TerminalClosed(
                                    node.get("terminalId").asLong(),
                                    node.get("exitCode").isNull()
                                            ? null
                                            : node.get("exitCode").asDouble())
                            : null;
            case "terminal-meta" -> {
                var metadata = metadata(node.get("meta"));
                yield u32(node.get("terminalId")) && metadata != null
                        ? new HostCommand.TerminalMetadata(
                                node.get("terminalId").asLong(), metadata)
                        : null;
            }
            case "terminal-replay-complete" ->
                    u32(node.get("terminalId")) && u32(node.get("lastOutputSeq"))
                            ? new HostCommand.ReplayComplete(
                                    node.get("terminalId").asLong(),
                                    node.get("lastOutputSeq").asLong())
                            : null;
            default -> null;
        };
    }

    static ParticipantCommand participantCommand(JsonNode node) {
        if (node == null || !node.isObject() || !node.has("type") || !node.get("type").isString())
            return null;
        return switch (node.get("type").asString()) {
            case "focus-terminal" -> {
                var id = node.get("terminalId");
                yield id != null && (id.isNull() || u32(id))
                        ? new ParticipantCommand.FocusTerminal(id.isNull() ? null : id.asLong())
                        : null;
            }
            case "move-cursor" -> {
                var position = node.get("position");
                if (position == null) yield null;
                if (position.isNull()) yield new ParticipantCommand.MoveCursor(null);
                yield position.isObject()
                                && workspaceCoordinate(position.get("x"))
                                && workspaceCoordinate(position.get("y"))
                        ? new ParticipantCommand.MoveCursor(
                                new CursorPosition(
                                        position.get("x").asDouble(), position.get("y").asDouble()))
                        : null;
            }
            case "rename-terminal" -> {
                var title = terminalTitle(node.get("title"));
                yield u32(node.get("terminalId")) && title != null
                        ? new ParticipantCommand.RenameTerminal(
                                node.get("terminalId").asLong(), title)
                        : null;
            }
            case "update-terminal-geometry" -> {
                var geometry = geometry(node.get("geometry"));
                yield u32(node.get("terminalId")) && geometry != null
                        ? new ParticipantCommand.UpdateTerminalGeometry(
                                node.get("terminalId").asLong(), geometry)
                        : null;
            }
            case "close-terminal-request" ->
                    u32(node.get("terminalId"))
                            ? new ParticipantCommand.CloseTerminal(node.get("terminalId").asLong())
                            : null;
            case "resize-request" ->
                    u32(node.get("terminalId"))
                                    && terminalDimension(node.get("cols"))
                                    && terminalDimension(node.get("rows"))
                            ? new ParticipantCommand.ResizeTerminal(
                                    node.get("terminalId").asLong(),
                                    node.get("cols").asInt(),
                                    node.get("rows").asInt())
                            : null;
            case "set-terminal-mode" -> {
                if (!u32(node.get("terminalId"))
                        || !node.has("mode")
                        || !node.get("mode").isString()) yield null;
                var mode =
                        switch (node.get("mode").asString()) {
                            case "exclusive" -> TerminalWorkspace.Mode.EXCLUSIVE;
                            case "shared" -> TerminalWorkspace.Mode.SHARED;
                            default -> null;
                        };
                yield mode == null
                        ? null
                        : new ParticipantCommand.SetTerminalMode(
                                node.get("terminalId").asLong(), mode);
            }
            case "acquire-lease" ->
                    u32(node.get("terminalId"))
                            ? new ParticipantCommand.AcquireLease(node.get("terminalId").asLong())
                            : null;
            case "release-lease" ->
                    u32(node.get("terminalId")) && u32(node.get("leaseId"))
                            ? new ParticipantCommand.ReleaseLease(
                                    node.get("terminalId").asLong(), node.get("leaseId").asLong())
                            : null;
            case "resync-output-request" ->
                    u32(node.get("terminalId"))
                            ? new ParticipantCommand.ResyncOutput(node.get("terminalId").asLong())
                            : null;
            case "open-terminal-request" ->
                    node.has("hostId") && node.get("hostId").isString()
                            ? new ParticipantCommand.OpenTerminal(node.get("hostId").asString())
                            : null;
            default -> null;
        };
    }

    private static String terminalRejection(TerminalRejection reason) {
        return switch (reason) {
            case TERMINAL_NOT_FOUND -> "terminal-not-found";
            case TERMINAL_NOT_OPEN -> "terminal-not-open";
            case HOST_OFFLINE -> "host-offline";
        };
    }

    private static String terminalTitle(JsonNode node) {
        if (node == null || !node.isString()) return null;
        var title = node.asString();
        int start = 0, end = title.length();
        while (start < end && titleWhitespace(title.charAt(start))) start++;
        while (end > start && titleWhitespace(title.charAt(end - 1))) end--;
        // Protocol v7 uses JavaScript trim and UTF-16 length, not Java trim/strip or code points.
        return end - start >= 1 && end - start <= 80 ? title.substring(start, end) : null;
    }

    private static boolean titleWhitespace(char c) {
        return switch (c) {
            case '\t',
                    '\n',
                    '\u000b',
                    '\f',
                    '\r',
                    ' ',
                    '\u00a0',
                    '\u1680',
                    '\u2028',
                    '\u2029',
                    '\u202f',
                    '\u205f',
                    '\u3000',
                    '\ufeff' ->
                    true;
            default -> c >= '\u2000' && c <= '\u200a';
        };
    }

    private static boolean workspaceCoordinate(JsonNode node) {
        return node != null
                && node.isNumber()
                && Double.isFinite(node.asDouble())
                && Math.abs(node.asDouble()) <= 0xffff;
    }

    private static TerminalWorkspace.Geometry geometry(JsonNode node) {
        if (node == null
                || !node.isObject()
                || !workspaceCoordinate(node.get("x"))
                || !workspaceCoordinate(node.get("y"))) return null;
        for (var field : new String[] {"width", "height"}) {
            var value = node.get(field);
            if (value == null || !value.isNumber() || !Double.isFinite(value.asDouble()))
                return null;
        }
        double x = node.get("x").asDouble(), y = node.get("y").asDouble();
        double width = node.get("width").asDouble(), height = node.get("height").asDouble();
        if (width <= 0 || width > 0xffff || height <= 0 || height > 0xffff) return null;
        return new TerminalWorkspace.Geometry(x, y, width, height);
    }

    private static boolean terminalDimension(JsonNode node) {
        return u32(node) && node.asLong() >= 1 && node.asLong() <= 0xffff;
    }

    private static HostCommand.Inventory inventory(JsonNode terminals) {
        if (terminals == null || !terminals.isArray()) return null;
        var runtimes = new ArrayList<HostCommand.Runtime>();
        for (var item : terminals) {
            if (!item.isObject()
                    || !u32(item.get("terminalId"))
                    || !u32(item.get("firstRetainedSeq"))
                    || !u32(item.get("lastOutputSeq"))
                    || !item.has("runtimeId")
                    || !item.get("runtimeId").isString()
                    || item.get("runtimeId").asString().isEmpty()) return null;
            runtimes.add(
                    new HostCommand.Runtime(
                            item.get("terminalId").asLong(),
                            item.get("runtimeId").asString(),
                            item.get("firstRetainedSeq").asLong(),
                            item.get("lastOutputSeq").asLong()));
        }
        return new HostCommand.Inventory(runtimes);
    }

    private static TerminalWorkspace.Metadata metadata(JsonNode node) {
        if (node == null || !node.isObject()) return null;
        for (var key : new String[] {"cwd", "gitBranch", "fgProcess"}) {
            var value = node.get(key);
            if (value == null || (!value.isNull() && !value.isString())) return null;
        }
        return new TerminalWorkspace.Metadata(
                node.get("cwd").isNull() ? null : node.get("cwd").asString(),
                node.get("gitBranch").isNull() ? null : node.get("gitBranch").asString(),
                node.get("fgProcess").isNull() ? null : node.get("fgProcess").asString());
    }

    private static boolean exitCode(JsonNode value) {
        return value != null
                && (value.isNull()
                        || (value.isNumber()
                                && Double.isFinite(value.asDouble())
                                && Math.floor(value.asDouble()) == value.asDouble()));
    }

    private static boolean u32(JsonNode value) {
        return value != null
                && value.isNumber()
                && value.asDouble() >= 0
                && value.asDouble() <= 0xffff_ffffL
                && Math.floor(value.asDouble()) == value.asDouble();
    }

    static Map<String, Object> encode(RoomNotice notice) {
        return switch (notice) {
            case Welcome welcome ->
                    Map.of(
                            "type", "welcome",
                            "selfClientId", welcome.selfClientId(),
                            "snapshot",
                                    Map.of(
                                            "roomId", welcome.roomId(),
                                            "name", welcome.roomName(),
                                            "participants",
                                                    welcome.participants().stream()
                                                            .map(RoomProtocol::participant)
                                                            .toList(),
                                            "hosts",
                                                    welcome.hosts().stream()
                                                            .map(RoomProtocol::host)
                                                            .toList(),
                                            "terminals",
                                                    welcome.terminals().stream()
                                                            .map(RoomProtocol::terminal)
                                                            .toList(),
                                            "leases",
                                                    welcome.leases().stream()
                                                            .map(RoomProtocol::lease)
                                                            .toList()));
            case ParticipantJoined joined ->
                    event(
                            Map.of(
                                    "kind",
                                    "participant-joined",
                                    "participant",
                                    participant(joined.participant())));
            case ParticipantFocusChanged focus -> {
                var fields = new LinkedHashMap<String, Object>();
                fields.put("kind", "participant-focus-changed");
                fields.put("clientId", focus.clientId());
                fields.put("focusedTerminalId", focus.focusedTerminalId());
                yield event(fields);
            }
            case ParticipantCursor cursor -> {
                var fields = new LinkedHashMap<String, Object>();
                fields.put("type", "participant-cursor");
                fields.put("clientId", cursor.clientId());
                fields.put(
                        "position",
                        cursor.position() == null
                                ? null
                                : Map.of("x", cursor.position().x(), "y", cursor.position().y()));
                yield fields;
            }
            case ParticipantLeft left ->
                    event(Map.of("kind", "participant-left", "clientId", left.clientId()));
            case HostOffline offline ->
                    event(Map.of("kind", "host-offline", "hostId", offline.hostId()));
            case HostRemoved removed ->
                    event(Map.of("kind", "host-removed", "hostId", removed.hostId()));
            case HostReady ready ->
                    Map.of(
                            "type",
                            "host-ready",
                            "terminals",
                            ready.terminals().stream()
                                    .map(
                                            t ->
                                                    Map.of(
                                                            "terminalId",
                                                            t.terminalId(),
                                                            "replayAfterSeq",
                                                            t.replayAfterSeq()))
                                    .toList());
            case OpenTerminal open ->
                    Map.of(
                            "type",
                            "open-terminal",
                            "terminalId",
                            open.terminalId(),
                            "cols",
                            80,
                            "rows",
                            24);
            case CloseTerminal close ->
                    Map.of("type", "close-terminal", "terminalId", close.terminalId());
            case ResizeTerminal resize ->
                    Map.of(
                            "type",
                            "resize",
                            "terminalId",
                            resize.terminalId(),
                            "cols",
                            resize.cols(),
                            "rows",
                            resize.rows());
            case TerminalCloseRejected rejected ->
                    Map.of(
                            "type",
                            "terminal-request-rejected",
                            "request",
                            "close",
                            "terminalId",
                            rejected.terminalId(),
                            "reason",
                            terminalRejection(rejected.reason()));
            case TerminalOpened opened ->
                    event(
                            Map.of(
                                    "kind",
                                    "terminal-opened",
                                    "terminal",
                                    terminal(opened.terminal())));
            case TerminalClosed closed -> {
                var fields = new LinkedHashMap<String, Object>();
                fields.put("kind", "terminal-closed");
                fields.put("terminalId", closed.terminalId());
                fields.put("exitCode", closed.exitCode());
                yield event(fields);
            }
            case TerminalMetadataChanged changed ->
                    event(
                            Map.of(
                                    "kind",
                                    "terminal-meta",
                                    "terminalId",
                                    changed.terminalId(),
                                    "meta",
                                    metadata(changed.metadata())));
            case TerminalRenamed renamed ->
                    event(
                            Map.of(
                                    "kind",
                                    "terminal-renamed",
                                    "terminalId",
                                    renamed.terminalId(),
                                    "title",
                                    renamed.title()));
            case TerminalGeometryChanged changed ->
                    event(
                            Map.of(
                                    "kind",
                                    "terminal-geometry-changed",
                                    "terminalId",
                                    changed.terminalId(),
                                    "geometry",
                                    geometry(changed.geometry())));
            case TerminalModeChanged changed ->
                    event(
                            Map.of(
                                    "kind",
                                    "terminal-mode-changed",
                                    "terminalId",
                                    changed.terminalId(),
                                    "mode",
                                    changed.mode().name().toLowerCase(Locale.ROOT)));
            case TerminalModeRejected rejected ->
                    Map.of(
                            "type",
                            "terminal-request-rejected",
                            "request",
                            "set-mode",
                            "terminalId",
                            rejected.terminalId(),
                            "reason",
                            terminalRejection(rejected.reason()));
            case LeaseAccepted accepted ->
                    Map.of(
                            "type",
                            "lease-result",
                            "terminalId",
                            accepted.terminalId(),
                            "result",
                            Map.of("kind", "granted", "leaseId", accepted.leaseId()));
            case LeaseDenied denied ->
                    Map.of(
                            "type",
                            "lease-result",
                            "terminalId",
                            denied.terminalId(),
                            "result",
                            Map.of("kind", "denied", "holderClientId", denied.holderClientId()));
            case LeaseInvalid invalid ->
                    Map.of(
                            "type",
                            "lease-invalid",
                            "terminalId",
                            invalid.terminalId(),
                            "reason",
                            switch (invalid.reason()) {
                                case TERMINAL_CLOSED -> "terminal-closed";
                                case REMOTE_INPUT_DISABLED -> "remote-input-disabled";
                                case NOT_HOLDER -> "not-holder";
                            });
            case LeaseGranted granted ->
                    event(Map.of("kind", "lease-granted", "lease", lease(granted.lease())));
            case LeaseReleased released ->
                    event(Map.of("kind", "lease-released", "terminalId", released.terminalId()));
            case Sync sync ->
                    Map.of("type", "sync", "terminalId", sync.terminalId(), "seq", sync.seq());
            case OutputGap gap ->
                    Map.of(
                            "type",
                            "output-gap",
                            "terminalId",
                            gap.terminalId(),
                            "fromSeq",
                            gap.fromSeq(),
                            "toSeq",
                            gap.toSeq());
            case ResyncRejected rejected ->
                    Map.of(
                            "type",
                            "terminal-request-rejected",
                            "request",
                            "resync-output",
                            "terminalId",
                            rejected.terminalId(),
                            "reason",
                            "terminal-not-found");
            case HostConnected connected ->
                    event(Map.of("kind", "host-connected", "host", host(connected.host())));
            case HostInputStateChanged input ->
                    event(
                            Map.of(
                                    "kind",
                                    "host-input-state-changed",
                                    "hostId",
                                    input.hostId(),
                                    "remoteInputAllowed",
                                    input.remoteInputAllowed()));
            case Rejected rejected ->
                    Map.of("type", "error", "code", rejected.code(), "message", rejected.message());
        };
    }

    private static Map<String, Object> event(Map<String, Object> event) {
        return Map.of("type", "room-event", "event", event);
    }

    private static Map<String, Object> participant(Participant participant) {
        var fields = new LinkedHashMap<String, Object>();
        fields.put("clientId", participant.clientId());
        fields.put("name", participant.name());
        fields.put("focusedTerminalId", participant.focusedTerminalId());
        return fields;
    }

    private static Map<String, Object> terminal(TerminalWorkspace.Terminal terminal) {
        var view = new LinkedHashMap<String, Object>();
        view.put("terminalId", terminal.terminalId());
        view.put("hostId", terminal.hostId());
        view.put("title", terminal.title());
        view.put("geometry", geometry(terminal.geometry()));
        view.put("mode", terminal.mode().name().toLowerCase(Locale.ROOT));
        view.put("status", terminal.status().name().toLowerCase(Locale.ROOT));
        view.put("exitCode", terminal.exitCode());
        view.put("meta", metadata(terminal.meta()));
        return view;
    }

    private static Map<String, Object> geometry(TerminalWorkspace.Geometry geometry) {
        return Map.of(
                "x",
                geometry.x(),
                "y",
                geometry.y(),
                "width",
                geometry.width(),
                "height",
                geometry.height());
    }

    private static Map<String, Object> metadata(TerminalWorkspace.Metadata metadata) {
        var fields = new LinkedHashMap<String, Object>();
        fields.put("cwd", metadata.cwd());
        fields.put("gitBranch", metadata.gitBranch());
        fields.put("fgProcess", metadata.fgProcess());
        return fields;
    }

    private static Map<String, Object> lease(LeaseControl.Lease lease) {
        return Map.of(
                "terminalId",
                lease.terminalId(),
                "leaseId",
                lease.leaseId(),
                "holderClientId",
                lease.holderClientId());
    }

    private static Map<String, Object> host(HostPresence.State host) {
        return Map.of(
                "hostId", host.hostId(),
                "name", host.name(),
                "online", host.online(),
                "remoteInputAllowed", host.remoteInputAllowed());
    }
}

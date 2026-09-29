package dev.ttyroom.adapter.http;

import dev.ttyroom.application.RoomCredentials;
import dev.ttyroom.application.RoomDirectory;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

@RestController
public final class RoomController {
    private static final int MAX_BODY_BYTES = 16 * 1024;
    // Match JavaScript String.trim(), including BOM/NBSP and excluding U+0085.
    private static final Pattern EDGE_SPACE =
            Pattern.compile(
                    "^[\\x09-\\x0D\\x20\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+|[\\x09-\\x0D\\x20\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+$");
    private final RoomDirectory rooms;
    private final JsonMapper json;

    public RoomController(RoomDirectory rooms, JsonMapper json) {
        this.rooms = rooms;
        this.json = json;
    }

    @PostMapping("/api/rooms")
    public ResponseEntity<?> create(HttpServletRequest request) throws IOException {
        var host = request.getHeader("Host");
        if (host == null || host.isEmpty()) {
            return ResponseEntity.badRequest()
                    .header("Content-Type", "text/plain;charset=UTF-8")
                    .body("host header required");
        }
        var body = readBody(request);
        if (!body.isObject()) return error(400, "invalid room name");
        String name = null;
        if (body.has("name")) {
            if (!body.get("name").isString()) return error(400, "invalid room name");
            name = EDGE_SPACE.matcher(body.get("name").asString()).replaceAll("");
            // Both Java and JS string length count UTF-16 code units.
            if (name.isEmpty() || name.length() > 80) return error(400, "invalid room name");
        }
        var invitation = rooms.create(name);
        return ResponseEntity.status(201)
                .header("Cache-Control", "no-store")
                .header("Content-Type", "application/json;charset=UTF-8")
                .body(
                        Map.of(
                                "roomId",
                                invitation.roomId(),
                                "name",
                                invitation.name(),
                                "token",
                                invitation.token(),
                                "managerCredential",
                                invitation.managerCredential(),
                                "joinUrl",
                                "http://"
                                        + host
                                        + "/r/"
                                        + invitation.roomId()
                                        + "#"
                                        + invitation.token()));
    }

    @PostMapping("/api/rooms/{roomId}/participants")
    public ResponseEntity<?> registerParticipant(
            @PathVariable String roomId, HttpServletRequest request) throws IOException {
        var body = readBody(request);
        if (!body.isObject()
                || !body.propertyNames().equals(Set.of("token"))
                || !body.path("token").isString())
            return error(400, "invalid registration request");
        var issued = rooms.registerParticipant(roomId, body.path("token").asString());
        return issued("participantId", issued);
    }

    @PostMapping("/api/rooms/{roomId}/hosts")
    public ResponseEntity<?> registerHost(@PathVariable String roomId, HttpServletRequest request)
            throws IOException {
        var body = readBody(request);
        if (!body.isObject() || !body.isEmpty()) return error(400, "invalid registration request");
        var headers = Collections.list(request.getHeaders("Authorization"));
        if (headers.size() != 1 || !headers.getFirst().matches("(?i:Bearer) [A-Za-z0-9_-]{32}"))
            return error(403, "registration forbidden");
        var issued = rooms.registerHost(roomId, headers.getFirst().substring(7));
        return issued("hostId", issued);
    }

    private ResponseEntity<?> issued(String idField, RoomCredentials.Issued issued) {
        return ResponseEntity.status(201)
                .header("Cache-Control", "no-store")
                .header("Content-Type", "application/json;charset=UTF-8")
                .body(Map.of(idField, issued.subject().id(), "credential", issued.secret()));
    }

    private JsonNode readBody(HttpServletRequest request) throws IOException {
        // Bound all JSON endpoints before parsing; parser diagnostics may contain secrets.
        var bytes = request.getInputStream().readNBytes(MAX_BODY_BYTES + 1);
        if (bytes.length > MAX_BODY_BYTES) throw new InvalidBody("request body too large");
        JsonNode body;
        try {
            body =
                    bytes.length == 0
                            ? json.createObjectNode()
                            : json.reader()
                                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                                    .readTree(new String(bytes, StandardCharsets.UTF_8));
        } catch (JacksonException invalid) {
            throw new InvalidBody("invalid json");
        }
        if (body == null || body.isMissingNode()) throw new InvalidBody("invalid json");
        return body;
    }

    private static final class InvalidBody extends RuntimeException {
        InvalidBody(String reason) {
            super(reason);
        }
    }

    @ExceptionHandler(InvalidBody.class)
    ResponseEntity<?> invalidBody(InvalidBody failure) {
        return error(400, failure.getMessage());
    }

    @ExceptionHandler(RoomDirectory.RegistrationRejected.class)
    ResponseEntity<?> forbidden() {
        return error(403, "registration forbidden");
    }

    @ExceptionHandler(IllegalStateException.class)
    ResponseEntity<?> unavailable() {
        return error(503, "registration unavailable");
    }

    @RequestMapping({"/api", "/api/**"})
    public ResponseEntity<?> unknownApi() {
        return error(404, "not found");
    }

    private ResponseEntity<?> error(int status, String reason) {
        return ResponseEntity.status(status)
                .header("Cache-Control", "no-store")
                .header("Content-Type", "application/json;charset=UTF-8")
                .body(Map.of("error", reason));
    }
}

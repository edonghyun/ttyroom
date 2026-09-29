package dev.ttyroom.adapter.config;

import org.springframework.core.env.Environment;

import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

/** Validated public startup settings; JSON and environment details stay at this boundary. */
public record ServerSettings(
        int port,
        int protocolVersion,
        String statePath,
        long participantGraceMs,
        long hostGraceMs,
        long scrollbackBytesPerTerminal,
        long sendBufferDropThresholdBytes,
        long maxQueuedDataBytesPerConnection) {
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Set<String> ROOT_FIELDS =
            Set.of("port", "protocolVersion", "statePath", "policy");
    private static final Set<String> POLICY_FIELDS =
            Set.of(
                    "participantGraceMs",
                    "hostGraceMs",
                    "scrollbackBytesPerTerminal",
                    "sendBufferDropThresholdBytes",
                    "maxQueuedDataBytesPerConnection",
                    "outputRateLimitBytesPerSec");

    public static ServerSettings load(Environment environment) {
        var file = readFile(environment.getProperty("TTYROOM_CONFIG_PATH"));
        requireFields(file, ROOT_FIELDS);
        var policy = file.path("policy");
        if (policy.isMissingNode()) policy = JsonMapper.builder().build().createObjectNode();
        requireFields(policy, POLICY_FIELDS);
        var root = new SettingsSource(environment, file);
        var policyValues = new SettingsSource(environment, policy);
        long outputRate =
                policyValues.positive(
                        "outputRateLimitBytesPerSec",
                        "TTYROOM_OUTPUT_RATE_LIMIT_BYTES_PER_SEC",
                        4_194_304);
        // The Connector owns throttling; the current protocol cannot negotiate this value.
        if (outputRate != 4_194_304)
            throw new IllegalArgumentException(
                    "outputRateLimitBytesPerSec override is not supported");
        return new ServerSettings(
                root.port(),
                (int) root.number("protocolVersion", "TTYROOM_PROTOCOL_VERSION", 7, 7, 8),
                root.statePath(),
                policyValues.nonNegative(
                        "participantGraceMs", "TTYROOM_PARTICIPANT_GRACE_MS", 15000),
                policyValues.nonNegative("hostGraceMs", "TTYROOM_HOST_GRACE_MS", 30000),
                policyValues.nonNegative(
                        "scrollbackBytesPerTerminal",
                        "TTYROOM_SCROLLBACK_BYTES_PER_TERMINAL",
                        1048576),
                policyValues.nonNegative(
                        "sendBufferDropThresholdBytes",
                        "TTYROOM_SEND_BUFFER_DROP_THRESHOLD_BYTES",
                        1048576),
                policyValues.positive(
                        "maxQueuedDataBytesPerConnection",
                        "TTYROOM_MAX_QUEUED_DATA_BYTES_PER_CONNECTION",
                        1048576));
    }

    private static JsonNode readFile(String explicitPath) {
        var json =
                JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        try {
            if (explicitPath != null && explicitPath.isBlank())
                throw new IllegalArgumentException();
            var path = Path.of(explicitPath == null ? "ttyroom.config.json" : explicitPath);
            try {
                return json.readTree(Files.readString(path));
            } catch (java.nio.file.NoSuchFileException missing) {
                if (explicitPath == null) return json.createObjectNode();
                throw missing;
            }
        } catch (IOException | RuntimeException failure) {
            // Parser exceptions can echo user-supplied JSON. Report the boundary, never its
            // content.
            throw new IllegalArgumentException("Cannot read TTYRoom config file");
        }
    }

    private static void requireFields(JsonNode node, Set<String> allowed) {
        if (node == null || !node.isObject() || !allowed.containsAll(node.propertyNames()))
            throw new IllegalArgumentException("Invalid or unknown TTYRoom config fields");
    }

    /** Resolves one JSON section against environment overrides before validating its values. */
    private record SettingsSource(Environment environment, JsonNode file) {
        private int port() {
            return (int)
                    number(
                            "port",
                            "TTYROOM_PORT",
                            environment.getProperty("server.port", Long.class, 3000L),
                            0,
                            65535);
        }

        private long nonNegative(String field, String variable, long fallback) {
            return number(field, variable, fallback, 0, MAX_SAFE_INTEGER);
        }

        private long positive(String field, String variable, long fallback) {
            return number(field, variable, fallback, 1, MAX_SAFE_INTEGER);
        }

        private String statePath() {
            var override = environment.getProperty("TTYROOM_STATE_PATH");
            // Preserve Spring's explicit memory mode from P4d; a blank file path is a typo.
            if (override != null && override.isEmpty()) return "";
            var node = file.path("statePath");
            if (override == null && node.isMissingNode()) return "";
            if (override == null && !node.isString()) throw invalid("statePath");
            var value = override == null ? node.asString() : override;
            if (value.isBlank()) throw invalid("statePath");
            return value.trim();
        }

        private long number(
                String field, String variable, long fallback, long minimum, long maximum) {
            var override = environment.getProperty(variable);
            var node = file.path(field);
            if (override == null && node.isMissingNode()) return fallback;
            if (override == null && !node.isNumber()) throw invalid(field);
            try {
                var raw = override == null ? node.asString() : override.trim();
                var value = new BigDecimal(raw).longValueExact();
                if (value < minimum || value > maximum) throw invalid(field);
                return value;
            } catch (ArithmeticException | NumberFormatException failure) {
                throw invalid(field);
            }
        }
    }

    private static IllegalArgumentException invalid(String field) {
        return new IllegalArgumentException("Invalid TTYRoom setting: " + field);
    }
}

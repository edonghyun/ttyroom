package dev.ttyroom.application;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/** Internal credential model; not yet connected to wire admission or durable storage. */
final class RoomCredentials {
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Entry> subjects = new HashMap<>();

    enum Role {
        PARTICIPANT,
        HOST
    }

    record Subject(Role role, String id) {}

    record Issued(Subject subject, String secret) {
        @Override
        public String toString() {
            return "Issued[subject=" + subject + ", secret=<redacted>]";
        }
    }

    synchronized Issued issue(Role role) {
        Objects.requireNonNull(role, "role");
        var subject = new Subject(role, UUID.randomUUID().toString());
        var bytes = new byte[24];
        random.nextBytes(bytes);
        var secret = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        subjects.put(subject.id(), new Entry(subject, digest(secret)));
        return new Issued(subject, secret);
    }

    synchronized Optional<Subject> authenticate(String secret) {
        if (secret == null || secret.length() != 32 || !secret.matches("[A-Za-z0-9_-]{32}")) {
            return Optional.empty();
        }
        var candidate = digest(secret);
        return subjects.values().stream()
                .filter(entry -> MessageDigest.isEqual(entry.digest, candidate))
                .map(entry -> entry.subject)
                .findFirst();
    }

    synchronized void revoke(String subjectId) {
        subjects.remove(subjectId);
    }

    private static byte[] digest(String secret) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(secret.getBytes(StandardCharsets.US_ASCII));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", exception);
        }
    }

    private static final class Entry {
        private final Subject subject;
        private final byte[] digest;

        private Entry(Subject subject, byte[] digest) {
            this.subject = subject;
            this.digest = digest;
        }
    }
}

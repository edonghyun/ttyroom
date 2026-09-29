package dev.ttyroom.application;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/** Room-local credentials. Only immutable storage values cross the application boundary. */
public final class RoomCredentials {
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Entry> subjects = new LinkedHashMap<>();

    RoomCredentials() {}

    public enum Role {
        PARTICIPANT,
        HOST,
        MANAGER
    }

    public record Subject(Role role, String id) {
        public Subject {
            Objects.requireNonNull(role, "role");
            if (id == null || !UUID.fromString(id).toString().equals(id))
                throw new IllegalArgumentException("Invalid credential subject");
        }
    }

    public record Stored(Subject subject, String digest) {
        public Stored {
            Objects.requireNonNull(subject, "subject");
            if (digest == null || !digest.matches("[a-f0-9]{64}"))
                throw new IllegalArgumentException("Invalid credential digest");
        }

        @Override
        public String toString() {
            return "Stored[subject=" + subject + ", digest=<redacted>]";
        }
    }

    static void validate(List<Stored> records) {
        var ids = new HashSet<String>();
        var digests = new HashSet<String>();
        for (var record : records) {
            if (!ids.add(record.subject().id()) || !digests.add(record.digest()))
                throw new IllegalArgumentException("Duplicate credential subject or digest");
        }
    }

    static RoomCredentials restore(List<Stored> records) {
        validate(records);
        var restored = new RoomCredentials();
        for (var record : records) {
            var entry = new Entry(record.subject(), HexFormat.of().parseHex(record.digest()));
            restored.subjects.put(entry.subject.id(), entry);
        }
        return restored;
    }

    synchronized List<Stored> durableState() {
        return subjects.values().stream()
                .map(entry -> new Stored(entry.subject, HexFormat.of().formatHex(entry.digest)))
                .toList();
    }

    public record Issued(Subject subject, String secret) {
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

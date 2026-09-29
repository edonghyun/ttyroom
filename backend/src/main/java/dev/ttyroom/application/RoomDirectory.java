package dev.ttyroom.application;

import dev.ttyroom.domain.RoomControl;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.Supplier;

/** Owns room identity, command ordering and save-before-commit changes. */
public final class RoomDirectory implements AutoCloseable {
    private final ConcurrentHashMap<String, Room> rooms = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    private final RoomStore store;
    private final ReentrantReadWriteLock lifetime = new ReentrantReadWriteLock(true);
    private volatile boolean closing;
    private boolean closed;

    public RoomDirectory() {
        this(RoomStore.transientOnly());
    }

    public RoomDirectory(RoomStore store) {
        this.store = Objects.requireNonNull(store);
        try {
            restore(store.loadAll());
        } catch (RuntimeException | Error failure) {
            try {
                store.close();
            } catch (RuntimeException | Error cleanup) {
                failure.addSuppressed(cleanup);
            }
            throw failure;
        }
    }

    /** Bootstrap only: load all durable rooms before opening admission. No sockets are needed. */
    public RoomDirectory(List<StoredRoom> storedRooms) {
        this.store = RoomStore.transientOnly();
        restore(storedRooms);
    }

    private void restore(List<StoredRoom> storedRooms) {
        for (var stored : storedRooms) {
            var room =
                    new Room(
                            stored.roomId(),
                            stored.name(),
                            HexFormat.of().parseHex(stored.tokenHash()),
                            RoomControl.restore(stored.control()));
            if (rooms.putIfAbsent(room.id, room) != null)
                throw new IllegalArgumentException("Duplicate room ID");
        }
    }

    public Invitation create(String name) {
        return duringOperation(() -> createRoom(name));
    }

    private Invitation createRoom(String name) {
        var bytes = new byte[24];
        random.nextBytes(bytes);
        var token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        var room =
                new Room(
                        UUID.randomUUID().toString(),
                        name == null ? "Quick Room" : name,
                        digest(token),
                        new RoomControl());
        store.save(room.durableState());
        rooms.put(room.id, room);
        return new Invitation(room.id, room.name, token);
    }

    public boolean acceptsToken(String roomId, String candidate) {
        if (roomId == null || candidate == null) return false;
        var room = rooms.get(roomId);
        return room != null && MessageDigest.isEqual(room.tokenHash, digest(candidate));
    }

    public static final class InvitationRejected extends RuntimeException {
        private final String code;

        private InvitationRejected(String code) {
            super(code);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    Room authenticatedRoom(String roomId, String token) {
        var room = rooms.get(roomId);
        if (room == null) throw new InvitationRejected("room-not-found");
        if (token == null || !MessageDigest.isEqual(room.tokenHash, digest(token)))
            throw new InvitationRejected("invalid-token");
        return room;
    }

    /** Serializes a room's admission, control and expiry through their socket effects. */
    <T> T execute(Room room, Function<RoomOperation, T> operation) {
        return duringOperation(
                () -> {
                    room.commands.lock();
                    try {
                        return operation.apply(new RoomOperation(room));
                    } finally {
                        room.commands.unlock();
                    }
                });
    }

    private <T> T duringOperation(Supplier<T> operation) {
        if (closing) throw new Closing();
        lifetime.readLock().lock();
        try {
            if (closing) throw new Closing();
            return operation.get();
        } finally {
            lifetime.readLock().unlock();
        }
    }

    /**
     * One ordered room operation, valid only inside execute. Its changes and final deletion stay
     * ahead of the next command, even when storage releases the room's state monitor.
     */
    final class RoomOperation {
        private final Room room;

        private RoomOperation(Room room) {
            this.room = room;
        }

        /** Live state changes share command order, but need no draft or durable save. */
        void runIf(BooleanSupplier eligible, Runnable action) {
            synchronized (room) {
                if (eligible.getAsBoolean()) action.run();
            }
        }

        /**
         * Tests eligibility and changes a private draft under the same state monitor as realtime
         * access. Saves without that monitor, then commits and delivers the result under it.
         * Returns null when ineligible. A storage failure commits nothing and skips delivery;
         * delivery failure does not roll back a saved decision. Eligibility is not rechecked after
         * saving: delivery decides which connection is still available.
         */
        <T, R> R changeIf(
                BooleanSupplier eligible, Function<RoomControl, T> update, Function<T, R> deliver) {
            RoomControl.Change<T> change;
            synchronized (room) {
                if (!eligible.getAsBoolean()) return null;
                change = room.control.stageChange(update);
            }
            if (change.recordToSave() != null) store.save(room.durableState(change.recordToSave()));
            synchronized (room) {
                change.commit();
                return deliver.apply(change.result());
            }
        }

        /** A separate durable decision: delete failure cannot undo an earlier change. */
        void remove() {
            store.delete(room.id);
            rooms.remove(room.id, room);
        }
    }

    static final class Closing extends IllegalStateException {
        Closing() {
            super("Room directory is closing");
        }
    }

    void stopAccepting() {
        closing = true;
    }

    @Override
    public void close() {
        stopAccepting();
        lifetime.writeLock().lock();
        try {
            if (closed) return;
            closed = true;
            store.close();
        } finally {
            lifetime.writeLock().unlock();
        }
    }

    private static byte[] digest(String token) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", impossible);
        }
    }

    /** Format/version mapping belongs to the storage adapter, not this application value. */
    public record StoredRoom(
            String roomId, String name, String tokenHash, RoomControl.DurableState control) {
        public StoredRoom {
            Objects.requireNonNull(roomId);
            Objects.requireNonNull(name);
            Objects.requireNonNull(tokenHash);
            Objects.requireNonNull(control);
            if (!tokenHash.matches("[0-9a-f]{64}"))
                throw new IllegalArgumentException("Invalid invitation digest");
        }

        @Override
        public String toString() {
            return "StoredRoom[roomId=" + roomId + ", tokenHash=<redacted>]";
        }
    }

    static final class Room {
        final String id;
        final String name;
        final RoomControl control;
        private final ReentrantLock commands = new ReentrantLock(true);
        private final byte[] tokenHash;

        Room(String id, String name, byte[] tokenHash, RoomControl control) {
            this.id = id;
            this.name = name;
            this.tokenHash = tokenHash.clone();
            this.control = control;
        }

        /** Shares the room monitor with mutations and realtime session access. */
        StoredRoom durableState() {
            synchronized (this) {
                return durableState(control.durableState());
            }
        }

        StoredRoom durableState(RoomControl.DurableState state) {
            return new StoredRoom(id, name, HexFormat.of().formatHex(tokenHash), state);
        }
    }

    public record Invitation(String roomId, String name, String token) {
        @Override
        public String toString() {
            return "Invitation[roomId=" + roomId + ", token=<redacted>]";
        }
    }
}

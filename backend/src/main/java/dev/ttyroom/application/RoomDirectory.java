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
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

/** Owns room identity, command ordering and save-before-commit changes. */
public final class RoomDirectory implements AutoCloseable {
    public record Limits(int rooms, int terminals) {
        public static final Limits DEFAULT = new Limits(4, 16);

        public Limits {
            if (rooms < 1 || terminals < 0)
                throw new IllegalArgumentException("Invalid room capacity");
        }
    }

    public static final class CapacityExceeded extends RuntimeException {
        private final String resource;

        CapacityExceeded(String resource) {
            super(resource + " capacity exhausted");
            this.resource = resource;
        }

        public String resource() {
            return resource;
        }
    }

    private final Limits limits;
    private int reservedRooms;
    private int reservedTerminals;

    // Only short counter changes hold this monitor; storage and room work never do.
    private synchronized void reserve(int roomCount, int terminalCount) {
        if (roomCount > limits.rooms() - reservedRooms) throw new CapacityExceeded("rooms");
        if (terminalCount > limits.terminals() - reservedTerminals)
            throw new CapacityExceeded("terminals");
        reservedRooms += roomCount;
        reservedTerminals += terminalCount;
    }

    private synchronized void release(int roomCount, int terminalCount) {
        reservedRooms -= roomCount;
        reservedTerminals -= terminalCount;
    }

    /** Reserve growth before saving; a failed save returns only that operation's reservation. */
    private void saveWithCapacity(Room room, StoredRoom record) {
        int target = record.control().workspace().terminals().size();
        int growth = Math.max(0, target - room.reservedTerminals);
        reserve(0, growth);
        try {
            store.save(record);
        } catch (RuntimeException | Error failure) {
            release(0, growth);
            throw failure;
        }
        release(0, Math.max(0, room.reservedTerminals - target));
        room.reservedTerminals = target;
    }

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
        this(store, Limits.DEFAULT);
    }

    public RoomDirectory(RoomStore store, Limits limits) {
        this.limits = Objects.requireNonNull(limits);
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
        this.limits = Limits.DEFAULT;
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
                            RoomControl.restore(stored.control()),
                            RoomCredentials.restore(stored.credentials()));
            reserve(1, room.reservedTerminals);
            if (rooms.putIfAbsent(room.id, room) != null)
                throw new IllegalArgumentException("Duplicate room ID");
        }
    }

    public Invitation create(String name) {
        return duringOperation(
                () -> {
                    reserve(1, 0);
                    try {
                        return createRoom(name);
                    } catch (RuntimeException | Error failure) {
                        release(1, 0);
                        throw failure;
                    }
                });
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
                        new RoomControl(),
                        new RoomCredentials());
        var manager = room.credentials.issue(RoomCredentials.Role.MANAGER);
        store.save(room.durableState());
        rooms.put(room.id, room);
        return new Invitation(room.id, room.name, token, manager.secret());
    }

    public boolean acceptsToken(String roomId, String candidate) {
        if (roomId == null || candidate == null) return false;
        var room = rooms.get(roomId);
        return room != null && MessageDigest.isEqual(room.tokenHash, digest(candidate));
    }

    public RoomCredentials.Issued registerParticipant(String roomId, String invitationToken) {
        var room = registrationRoom(roomId);
        return execute(
                room,
                operation ->
                        operation.changeCredentials(
                                draft -> {
                                    if (!acceptsToken(roomId, invitationToken))
                                        throw new RegistrationRejected();
                                    return draft.issue(RoomCredentials.Role.PARTICIPANT);
                                }));
    }

    public RoomCredentials.Issued registerHost(String roomId, String managerCredential) {
        var room = registrationRoom(roomId);
        return execute(
                room,
                operation ->
                        operation.changeCredentials(
                                draft -> {
                                    var manager = draft.authenticate(managerCredential);
                                    if (manager.isEmpty()
                                            || manager.get().role() != RoomCredentials.Role.MANAGER)
                                        throw new RegistrationRejected();
                                    return draft.issue(RoomCredentials.Role.HOST);
                                }));
    }

    private Room registrationRoom(String roomId) {
        var room = roomId == null ? null : rooms.get(roomId);
        if (room == null) throw new RegistrationRejected();
        return room;
    }

    /** Missing rooms and invalid authority share one public rejection. */
    public static final class RegistrationRejected extends IllegalStateException {
        private RegistrationRejected() {
            super("Registration forbidden");
        }
    }

    public static final class RevocationRejected extends IllegalStateException {
        RevocationRejected() {
            super("Revocation forbidden");
        }
    }

    /**
     * Internal registration step. Caller authorization and wire admission are separate contracts.
     */
    RoomCredentials.Issued issueCredential(Room room, RoomCredentials.Role role) {
        return execute(room, operation -> operation.changeCredentials(draft -> draft.issue(role)));
    }

    void revokeCredential(Room room, String subjectId) {
        execute(
                room,
                operation ->
                        operation.changeCredentials(
                                draft -> {
                                    draft.revoke(subjectId);
                                    return null;
                                }));
    }

    /** A committed-state lookup, not permission to attach a WebSocket session. */
    Optional<RoomCredentials.Subject> authenticateCredential(Room room, String secret) {
        synchronized (room) {
            return rooms.get(room.id) == room
                    ? room.credentials.authenticate(secret)
                    : Optional.empty();
        }
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

    /** Lookup only. Admission must authenticate again inside execute before creating presence. */
    Room roomForAdmission(String roomId) {
        return roomId == null ? null : rooms.get(roomId);
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
            if (change.recordToSave() != null)
                saveWithCapacity(room, room.durableState(change.recordToSave()));
            synchronized (room) {
                change.commit();
                return deliver.apply(change.result());
            }
        }

        private <T> T changeCredentials(Function<RoomCredentials, T> update) {
            RoomCredentials draft;
            StoredRoom record;
            T result;
            synchronized (room) {
                if (rooms.get(room.id) != room) throw new RegistrationRejected();
                var before = room.credentials.durableState();
                draft = RoomCredentials.restore(before);
                result = update.apply(draft);
                var after = draft.durableState();
                if (before.equals(after)) return result;
                record = room.durableState(room.control.durableState(), after);
            }
            store.save(record);
            synchronized (room) {
                room.credentials = draft;
                return result;
            }
        }

        /** Saves credential and host removal together before publishing any live effects. */
        void revokeCredential(
                String managerCredential,
                RoomCredentials.Subject subject,
                Consumer<List<Long>> deliver) {
            RoomCredentials draft;
            RoomControl.Change<List<Long>> controlChange;
            StoredRoom record;
            synchronized (room) {
                var manager = room.credentials.authenticate(managerCredential);
                if (rooms.get(room.id) != room
                        || manager.isEmpty()
                        || manager.get().role() != RoomCredentials.Role.MANAGER
                        || subject.role() == RoomCredentials.Role.MANAGER)
                    throw new RevocationRejected();
                draft = RoomCredentials.restore(room.credentials.durableState());
                if (!draft.revoke(subject)) return;
                controlChange =
                        room.control.stageChange(
                                control ->
                                        subject.role() == RoomCredentials.Role.HOST
                                                ? control.removeHost(subject.id())
                                                : List.<Long>of());
                var controlState = controlChange.recordToSave();
                record =
                        room.durableState(
                                controlState == null ? room.control.durableState() : controlState,
                                draft.durableState());
            }
            saveWithCapacity(room, record);
            synchronized (room) {
                room.credentials = draft;
                controlChange.commit();
                deliver.accept(controlChange.result());
            }
        }

        /** A separate durable decision: delete failure cannot undo an earlier change. */
        void remove() {
            store.delete(room.id);
            if (rooms.remove(room.id, room)) release(1, room.reservedTerminals);
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
            String roomId,
            String name,
            String tokenHash,
            RoomControl.DurableState control,
            List<RoomCredentials.Stored> credentials) {
        public StoredRoom(
                String roomId, String name, String tokenHash, RoomControl.DurableState control) {
            this(roomId, name, tokenHash, control, List.of());
        }

        public StoredRoom {
            Objects.requireNonNull(roomId);
            Objects.requireNonNull(name);
            Objects.requireNonNull(tokenHash);
            Objects.requireNonNull(control);
            credentials = List.copyOf(credentials);
            RoomCredentials.validate(credentials);
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
        private RoomCredentials credentials;
        private int reservedTerminals;
        private final ReentrantLock commands = new ReentrantLock(true);
        private final byte[] tokenHash;

        Room(
                String id,
                String name,
                byte[] tokenHash,
                RoomControl control,
                RoomCredentials credentials) {
            this.id = id;
            this.name = name;
            this.tokenHash = tokenHash.clone();
            this.control = control;
            this.reservedTerminals = control.durableState().workspace().terminals().size();
            this.credentials = credentials;
        }

        /** Shares the room monitor with mutations and realtime session access. */
        StoredRoom durableState() {
            synchronized (this) {
                return durableState(control.durableState());
            }
        }

        StoredRoom durableState(RoomControl.DurableState state) {
            return durableState(state, credentials.durableState());
        }

        private StoredRoom durableState(
                RoomControl.DurableState state, List<RoomCredentials.Stored> credentials) {
            return new StoredRoom(
                    id, name, HexFormat.of().formatHex(tokenHash), state, credentials);
        }
    }

    public record Invitation(String roomId, String name, String token, String managerCredential) {
        @Override
        public String toString() {
            return "Invitation[roomId=" + roomId + ", token=<redacted>]";
        }
    }
}

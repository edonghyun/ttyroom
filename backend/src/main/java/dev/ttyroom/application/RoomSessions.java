package dev.ttyroom.application;

import dev.ttyroom.application.RoomNotice.*;
import dev.ttyroom.domain.HostPresence;
import dev.ttyroom.domain.LeaseControl;
import dev.ttyroom.domain.RoomControl;
import dev.ttyroom.domain.RoomControl.InputRejection;
import dev.ttyroom.domain.RoomControl.TerminalRejection;
import dev.ttyroom.domain.TerminalWorkspace;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * Owns room-scoped connection lifecycles and serializes their host reports with admission and
 * expiry.
 */
public final class RoomSessions implements AutoCloseable {
    public record Limits(int membershipsPerRoom, int memberships) {
        public static final Limits DEFAULT = new Limits(64, 128);

        public Limits {
            if (membershipsPerRoom < 1 || memberships < 1)
                throw new IllegalArgumentException("Invalid membership capacity");
        }
    }

    public enum Role {
        PARTICIPANT,
        HOST
    }

    /** Bound to one authenticated connection. Old sessions cannot mutate their replacements. */
    public interface Session {
        void handle(HostCommand command);

        void disconnect();

        void output(OutputFrame frame);

        void input(InputFrame frame);

        void handle(ParticipantCommand command);
    }

    public interface Peer {
        /**
         * Accept the message for sending without waiting for network I/O, or throw PeerUnavailable
         * for an expected transport failure. Acceptance is not delivery.
         */
        void send(RoomNotice notice);

        /**
         * Enqueue input without retry or silent dropping; throws PeerUnavailable on backpressure.
         */
        void sendInput(InputFrame frame);

        /**
         * Atomically accept optional gap markers and output, or return false under backpressure.
         */
        boolean offerOutput(OutputFrame frame, OutputGap precedingGap);

        /**
         * Reserve an immutable replay followed by its sync, ordered with other sends. Does not wait
         * for I/O. Runs afterSync only after the final sync is written and its reservation
         * released, outside transport locks. Cancellation/failure never reports completion. Throws
         * PeerUnavailable if the replay budget is exhausted.
         */
        void replayOutput(List<OutputFrame> frames, Sync boundary, Runnable afterSync);

        /** Initiate a best-effort close without waiting for network I/O. */
        void close();
    }

    public static final class PeerUnavailable extends RuntimeException {
        public PeerUnavailable(String message) {
            super(message);
        }

        public PeerUnavailable(Throwable cause) {
            super("Peer transport is unavailable", cause);
        }
    }

    public record Policy(
            long participantGraceMs, long hostGraceMs, long scrollbackBytesPerTerminal) {
        public static final Policy DEFAULT = new Policy(15_000, 30_000, 1_048_576);

        public Policy {
            if (participantGraceMs < 0 || hostGraceMs < 0 || scrollbackBytesPerTerminal < 0)
                throw new IllegalArgumentException("Room policy values must be nonnegative");
        }
    }

    public sealed interface AdmissionRequest permits Hello, CredentialHello {
        double protocolVersion();

        String roomId();

        String name();
    }

    /** v8: role and identity are never supplied by the client. */
    public record CredentialHello(
            double protocolVersion, String roomId, String credential, String name)
            implements AdmissionRequest {
        @Override
        public String toString() {
            return "CredentialHello[credentials=<redacted>]";
        }
    }

    /** Temporary process-wide compatibility selection; never negotiated per connection. */
    public enum AdmissionMode {
        INVITATION_V7(7),
        CREDENTIAL_V8(8);
        private final int version;

        AdmissionMode(int version) {
            this.version = version;
        }
    }

    public record Hello(
            double protocolVersion,
            String roomId,
            String token,
            String clientId,
            String name,
            Role role)
            implements AdmissionRequest {
        @Override
        public String toString() {
            return "Hello[credentials=<redacted>]";
        }
    }

    private record Identity(Role role, String clientId) {}

    private record Authenticated(Identity identity, String name) {}

    private static final class Member {
        final Identity identity;
        final String name;
        final Peer peer;
        final HostPresence host;
        // Presence outlives a connection through grace/replacement, and ends on member expiry.
        Long focusedTerminalId;
        final LinkedHashSet<Long> restoring = new LinkedHashSet<>();
        boolean connected = true;
        ExpiryTimers.Cancellation expiry;

        Member(Authenticated authenticated, Peer peer) {
            this.identity = authenticated.identity();
            this.name = authenticated.name();
            this.peer = peer;
            this.host =
                    identity.role() == Role.HOST
                            ? new HostPresence(identity.clientId(), name)
                            : null;
        }

        void cancelExpiry() {
            if (expiry != null) expiry.cancel();
            expiry = null;
        }
    }

    /** Data describing delivery after a durable decision, never deferred model mutations. */
    private sealed interface ChangeResult {
        record Unchanged() implements ChangeResult {}

        record Reply(RoomNotice notice) implements ChangeResult {}

        record Broadcast(RoomNotice notice) implements ChangeResult {}

        record HostRequest(Member host, RoomNotice command) implements ChangeResult {}

        record Inventory(TerminalWorkspace.Reconciliation reconciliation) implements ChangeResult {}
    }

    private static final class Presence {
        final String roomId;
        final RoomDirectory.Room state;
        final RoomControl control;
        final TerminalOutput output;
        final Map<Identity, Member> members = new LinkedHashMap<>();

        Presence(RoomDirectory.Room room, Policy policy) {
            this.output = new TerminalOutput(policy.scrollbackBytesPerTerminal());
            this.roomId = room.id;
            this.state = room;
            this.control = room.control;
        }
    }

    private final RoomDirectory rooms;
    private final ConcurrentHashMap<String, Presence> presence = new ConcurrentHashMap<>();
    private final ExpiryTimers timers;
    private final Policy policy;
    private final Limits limits;
    private int memberships;
    private final AdmissionMode admissionMode;
    private volatile boolean closing;
    private volatile boolean closed;

    public RoomSessions(RoomDirectory rooms) {
        this(rooms, new ExpiryTimers());
    }

    public RoomSessions(RoomDirectory rooms, Policy policy) {
        this(rooms, new ExpiryTimers(), policy);
    }

    RoomSessions(RoomDirectory rooms, ExpiryTimers timers) {
        this(rooms, timers, Policy.DEFAULT);
    }

    private RoomSessions(RoomDirectory rooms, ExpiryTimers timers, Policy policy) {
        this(rooms, timers, policy, AdmissionMode.INVITATION_V7);
    }

    public RoomSessions(RoomDirectory rooms, Policy policy, AdmissionMode mode) {
        this(rooms, new ExpiryTimers(), policy, mode);
    }

    RoomSessions(RoomDirectory rooms, ExpiryTimers timers, Policy policy, AdmissionMode mode) {
        this(rooms, timers, policy, mode, Limits.DEFAULT);
    }

    public RoomSessions(RoomDirectory rooms, Policy policy, AdmissionMode mode, Limits limits) {
        this(rooms, new ExpiryTimers(), policy, mode, limits);
    }

    RoomSessions(
            RoomDirectory rooms,
            ExpiryTimers timers,
            Policy policy,
            AdmissionMode mode,
            Limits limits) {
        this.rooms = rooms;
        this.limits = Objects.requireNonNull(limits);
        this.timers = timers;
        this.policy = Objects.requireNonNull(policy);
        this.admissionMode = Objects.requireNonNull(mode);
    }

    /** One history reservation per joining connection; pending terminals stay in room history. */
    private void replayNext(Presence room, Member member) {
        synchronized (room.state) {
            if (closed || room.members.get(member.identity) != member || !member.connected) return;
            if (member.restoring.isEmpty()) return;
            long terminalId = member.restoring.removeFirst();
            room.output.replay(
                    member.peer,
                    terminalId,
                    () -> {
                        try {
                            replayNext(room, member);
                        } catch (RuntimeException failure) {
                            disconnected(room, member.identity, member);
                            member.peer.close();
                            if (!(failure instanceof PeerUnavailable)) throw failure;
                        }
                    });
        }
    }

    /** Returns a connection-scoped session, or null if admission was rejected or failed. */
    public Session join(AdmissionRequest request, Peer peer) {
        if (request.protocolVersion() != admissionMode.version
                || (admissionMode == AdmissionMode.INVITATION_V7 && !(request instanceof Hello))
                || (admissionMode == AdmissionMode.CREDENTIAL_V8
                        && !(request instanceof CredentialHello))) {
            reject(peer, "unsupported-protocol-version", "server=" + admissionMode.version);
            return null;
        }
        var state = rooms.roomForAdmission(request.roomId());
        if (state == null) {
            var code = request instanceof Hello ? "room-not-found" : "invalid-credential";
            reject(peer, code, code);
            return null;
        }
        // Authenticate and attach in the same command order as credential revocation/deletion.
        // Unauthenticated requests never allocate presence or supersede an existing connection.
        return rooms.execute(
                state,
                operation -> {
                    var authenticated = authenticate(request, state, peer);
                    if (authenticated == null) return null;
                    var room =
                            presence.computeIfAbsent(
                                    state.id, ignored -> new Presence(state, policy));
                    var identity = authenticated.identity();
                    boolean reserved;
                    synchronized (state) {
                        try {
                            reserved = reserveMember(room, identity);
                        } catch (RoomDirectory.CapacityExceeded exhausted) {
                            reject(peer, "capacity-exhausted", exhausted.getMessage());
                            return null;
                        }
                    }
                    try {
                        return operation.changeIf(
                                () -> true,
                                draft -> {
                                    if (identity.role() == Role.HOST)
                                        draft.rememberHost(
                                                identity.clientId(), authenticated.name());
                                    return new Member(authenticated, peer);
                                },
                                member -> attach(room, member));
                    } catch (RoomDirectory.CapacityExceeded exhausted) {
                        reject(peer, "capacity-exhausted", exhausted.getMessage());
                        return null;
                    } finally {
                        synchronized (state) {
                            if (reserved && !room.members.containsKey(identity)) releaseMember();
                        }
                    }
                });
    }

    /** Called in room order; the global monitor protects counters, never storage or delivery. */
    private synchronized boolean reserveMember(Presence room, Identity identity) {
        if (room.members.containsKey(identity)) return false;
        if (room.members.size() >= limits.membershipsPerRoom())
            throw new RoomDirectory.CapacityExceeded("room memberships");
        if (memberships >= limits.memberships())
            throw new RoomDirectory.CapacityExceeded("memberships");
        memberships++;
        return true;
    }

    private synchronized void releaseMember() {
        memberships--;
    }

    /** Runs after registration is committed, under the room state monitor. */
    private Session attach(Presence room, Member member) {
        var identity = member.identity;
        var peer = member.peer;
        var previous = room.members.put(identity, member);
        if (previous != null) member.focusedTerminalId = previous.focusedTerminalId;
        try {
            peer.send(welcome(room, member, room.state.name));
        } catch (RuntimeException failure) {
            // No join event was published and the old session has not been superseded yet.
            if (previous == null) room.members.remove(identity);
            else room.members.put(identity, previous);
            peer.close();
            if (!(failure instanceof PeerUnavailable)) throw failure;
            return null;
        }
        try {
            if (previous != null) {
                previous.cancelExpiry();
                previous.restoring.clear();
                previous.peer.close();
            } else if (identity.role() == Role.PARTICIPANT) {
                broadcast(room, member, new ParticipantJoined(participant(member)));
            }
            if (identity.role() == Role.PARTICIPANT) {
                for (var terminal : room.control.terminals()) {
                    if (terminal.status() == TerminalWorkspace.Status.OPEN)
                        member.restoring.add(terminal.terminalId());
                }
                replayNext(room, member);
            }
        } catch (RuntimeException failure) {
            // A programming error must surface, but this caller will never receive its
            // callback.
            disconnected(room, identity, member);
            peer.close();
            if (failure instanceof PeerUnavailable) return null;
            throw failure;
        }
        return new AttachedSession(room, member);
    }

    private final class AttachedSession implements Session {
        private final Presence room;
        private final Member member;

        AttachedSession(Presence room, Member member) {
            this.room = room;
            this.member = member;
        }

        @Override
        public void disconnect() {
            disconnected(room, member.identity, member);
        }

        @Override
        public void handle(HostCommand command) {
            if (member.identity.role() != Role.HOST) {
                executeLive(
                        () ->
                                reply(
                                        new Rejected(
                                                "bad-message",
                                                "host command requires a host session")));
                return;
            }
            switch (command) {
                case HostCommand.ReplayComplete complete ->
                        executeLive(() -> acknowledgeReplay(complete));
                case HostCommand.InputState input -> executeLive(() -> reportInputState(input));
                case HostCommand.Inventory ignored -> change(draft -> updateHost(command, draft));
                case HostCommand.TerminalOpened ignored ->
                        change(draft -> updateHost(command, draft));
                case HostCommand.TerminalClosed ignored ->
                        change(draft -> updateHost(command, draft));
                case HostCommand.TerminalMetadata ignored ->
                        change(draft -> updateHost(command, draft));
            }
        }

        private void change(Function<RoomControl, ChangeResult> update) {
            rooms.execute(
                    room.state,
                    operation -> {
                        try {
                            return operation.changeIf(
                                    this::current,
                                    update,
                                    result -> {
                                        publish(result);
                                        return null;
                                    });
                        } catch (RoomDirectory.CapacityExceeded full) {
                            operation.runIf(
                                    this::current,
                                    () ->
                                            reply(
                                                    new Rejected(
                                                            "capacity-exhausted",
                                                            full.resource())));
                            return null;
                        }
                    });
        }

        private void executeLive(Runnable action) {
            rooms.execute(
                    room.state,
                    operation -> {
                        operation.runIf(
                                this::current,
                                () -> {
                                    try {
                                        action.run();
                                    } catch (PeerUnavailable unavailable) {
                                        disconnect();
                                        member.peer.close();
                                    }
                                });
                        return null;
                    });
        }

        private void publish(ChangeResult result) {
            try {
                switch (result) {
                    case ChangeResult.Unchanged ignored -> {}
                    case ChangeResult.Reply response -> reply(response.notice());
                    case ChangeResult.Broadcast event -> broadcast(room, null, event.notice());
                    case ChangeResult.HostRequest request -> {
                        if (!sendTerminalCommand(request.host(), request.command()))
                            reply(new Rejected("bad-message", "host is unavailable"));
                    }
                    case ChangeResult.Inventory inventory ->
                            publishInventory(inventory.reconciliation());
                }
            } catch (PeerUnavailable unavailable) {
                disconnect();
                member.peer.close();
            }
        }

        private void reply(RoomNotice notice) {
            if (current()) member.peer.send(notice);
        }

        private boolean current() {
            return !closed && room.members.get(member.identity) == member && member.connected;
        }

        @Override
        public void output(OutputFrame frame) {
            // Fast data entry: no JSON command routing or persistence transaction queue.
            synchronized (room.state) {
                if (!current()) return;
                if (member.identity.role() != Role.HOST
                        || !room.control.ownsOpenTerminal(
                                member.identity.clientId(), frame.terminalId())) {
                    try {
                        reply(new Rejected("bad-message", "host does not own an open terminal"));
                    } catch (PeerUnavailable unavailable) {
                        disconnect();
                        member.peer.close();
                    }
                    return;
                }
                var accepted = room.output.accept(frame);
                if (accepted == null) return;
                for (var target : List.copyOf(room.members.values())) {
                    if (!target.connected
                            || target.identity.role() != Role.PARTICIPANT
                            || target.restoring.contains(accepted.terminalId())) continue;
                    try {
                        room.output.deliver(target.peer, accepted);
                    } catch (PeerUnavailable unavailable) {
                        disconnected(room, target.identity, target);
                        target.peer.close();
                    }
                }
            }
        }

        @Override
        public void handle(ParticipantCommand command) {
            if (command instanceof ParticipantCommand.MoveCursor cursor) {
                // Ephemeral movement never queues behind a durable save.
                synchronized (room.state) {
                    if (!current()) return;
                    try {
                        if (member.identity.role() == Role.PARTICIPANT)
                            broadcast(
                                    room,
                                    member,
                                    new ParticipantCursor(
                                            member.identity.clientId(), cursor.position()));
                        else
                            reply(
                                    new Rejected(
                                            "bad-message",
                                            "request requires a participant session"));
                    } catch (PeerUnavailable unavailable) {
                        disconnect();
                        member.peer.close();
                    }
                }
                return;
            }
            if (member.identity.role() != Role.PARTICIPANT) {
                executeLive(
                        () ->
                                reply(
                                        new Rejected(
                                                "bad-message",
                                                "request requires a participant session")));
                return;
            }
            switch (command) {
                case ParticipantCommand.ResyncOutput resync ->
                        executeLive(() -> resyncOutput(resync.terminalId()));
                case ParticipantCommand.FocusTerminal focus ->
                        executeLive(() -> focusTerminal(focus.terminalId()));
                case ParticipantCommand.CloseTerminal close ->
                        executeLive(() -> closeTerminal(close.terminalId()));
                case ParticipantCommand.ResizeTerminal resize ->
                        executeLive(() -> resizeTerminal(resize));
                case ParticipantCommand.AcquireLease acquire ->
                        executeLive(() -> acquireLease(acquire.terminalId()));
                case ParticipantCommand.ReleaseLease release ->
                        executeLive(() -> releaseLease(release));
                case ParticipantCommand.RenameTerminal rename ->
                        change(draft -> renameTerminal(rename, draft));
                case ParticipantCommand.UpdateTerminalGeometry update ->
                        change(draft -> updateGeometry(update, draft));
                case ParticipantCommand.SetTerminalMode mode ->
                        change(draft -> updateMode(mode, draft));
                case ParticipantCommand.OpenTerminal open ->
                        change(draft -> openTerminal(open.hostId(), draft));
                case ParticipantCommand.MoveCursor ignored ->
                        throw new IllegalStateException("Cursor bypasses control commands");
            }
        }

        private ChangeResult renameTerminal(
                ParticipantCommand.RenameTerminal command, RoomControl draft) {
            if (!draft.renameTerminal(command.terminalId(), command.title()))
                return new ChangeResult.Unchanged();
            return new ChangeResult.Broadcast(
                    new TerminalRenamed(command.terminalId(), command.title()));
        }

        private ChangeResult updateGeometry(
                ParticipantCommand.UpdateTerminalGeometry command, RoomControl draft) {
            if (!draft.updateTerminalGeometry(command.terminalId(), command.geometry()))
                return new ChangeResult.Unchanged();
            return new ChangeResult.Broadcast(
                    new TerminalGeometryChanged(command.terminalId(), command.geometry()));
        }

        private void resyncOutput(long terminalId) {
            if (room.control.terminal(terminalId).isEmpty()) reply(new ResyncRejected(terminalId));
            else if (!member.restoring.contains(terminalId))
                room.output.replay(member.peer, terminalId);
        }

        private void releaseLease(ParticipantCommand.ReleaseLease release) {
            if (room.control.releaseLease(
                    member.identity.clientId(), release.terminalId(), release.leaseId()))
                broadcast(room, null, new LeaseReleased(release.terminalId()));
            else reply(new LeaseInvalid(release.terminalId(), InputRejection.NOT_HOLDER));
        }

        private void focusTerminal(Long terminalId) {
            // Only existence matters: pending, exited and offline terminals can still be viewed.
            // Validate before equality: a removed target must be rejected even if still focused.
            if (terminalId != null && room.control.terminal(terminalId).isEmpty()) {
                reply(new Rejected("bad-message", "존재하지 않는 터미널 focus: " + terminalId));
                return;
            }
            if (Objects.equals(member.focusedTerminalId, terminalId)) return;
            member.focusedTerminalId = terminalId;
            broadcast(
                    room,
                    null,
                    new ParticipantFocusChanged(member.identity.clientId(), terminalId));
        }

        private Member terminalHost(long terminalId) {
            return room.control
                    .terminal(terminalId)
                    .map(terminal -> room.members.get(new Identity(Role.HOST, terminal.hostId())))
                    .orElse(null);
        }

        private ChangeResult updateMode(
                ParticipantCommand.SetTerminalMode command, RoomControl draft) {
            var host = terminalHost(command.terminalId());
            var result =
                    draft.setTerminalMode(
                            command.terminalId(),
                            command.mode(),
                            host != null && host.connected ? host.identity.clientId() : null);
            return switch (result) {
                case RoomControl.ModeChange.Changed ignored ->
                        new ChangeResult.Broadcast(
                                new TerminalModeChanged(command.terminalId(), command.mode()));
                case RoomControl.ModeChange.Unchanged ignored -> new ChangeResult.Unchanged();
                case RoomControl.ModeChange.Rejected rejected ->
                        new ChangeResult.Reply(
                                new TerminalModeRejected(command.terminalId(), rejected.reason()));
            };
        }

        private void closeTerminal(long terminalId) {
            var host = terminalHost(terminalId);
            var rejection =
                    room.control.terminalRequestRejection(
                            terminalId,
                            host != null && host.connected ? host.identity.clientId() : null);
            if (rejection.isPresent()) {
                reply(new TerminalCloseRejected(terminalId, rejection.get()));
                return;
            }
            if (!sendTerminalCommand(host, new CloseTerminal(terminalId)))
                reply(new TerminalCloseRejected(terminalId, TerminalRejection.HOST_OFFLINE));
        }

        private void resizeTerminal(ParticipantCommand.ResizeTerminal resize) {
            var host = terminalHost(resize.terminalId());
            var rejection =
                    room.control.terminalRequestRejection(
                            resize.terminalId(),
                            host != null && host.connected ? host.identity.clientId() : null);
            if (rejection.isPresent()) {
                reply(new Rejected("bad-message", "열린 터미널의 online host가 없다"));
                return;
            }
            if (!sendTerminalCommand(
                    host, new ResizeTerminal(resize.terminalId(), resize.cols(), resize.rows())))
                reply(new Rejected("bad-message", "host is unavailable"));
        }

        /**
         * Acceptance is not PTY completion. Keep state for the host report or inventory recovery.
         */
        private boolean sendTerminalCommand(Member host, RoomNotice command) {
            if (!host.connected || room.members.get(host.identity) != host) return false;
            try {
                host.peer.send(command);
                return true;
            } catch (PeerUnavailable unavailable) {
                // Delivery is uncertain. Isolate the failed host without retrying the command.
                disconnected(room, host.identity, host);
                host.peer.close();
                return false;
            }
        }

        private void acquireLease(long terminalId) {
            LeaseControl.Acquisition result;
            try {
                result = room.control.acquireLease(member.identity.clientId(), terminalId);
            } catch (RoomControl.TerminalUnavailable unavailable) {
                reply(new LeaseInvalid(terminalId, InputRejection.TERMINAL_CLOSED));
                return;
            } catch (LeaseControl.IdsExhausted exhausted) {
                reply(new Rejected("bad-message", "lease ID space exhausted"));
                return;
            }
            switch (result) {
                case LeaseControl.Acquisition.Denied denied ->
                        reply(new LeaseDenied(terminalId, denied.holderClientId()));
                case LeaseControl.Acquisition.AlreadyHeld held ->
                        reply(new LeaseAccepted(terminalId, held.lease().leaseId()));
                case LeaseControl.Acquisition.Acquired acquired -> {
                    try {
                        reply(new LeaseAccepted(terminalId, acquired.lease().leaseId()));
                    } finally {
                        // The lease is committed. Reply failure must not hide it from other
                        // observers.
                        if (acquired.released() != null)
                            broadcast(
                                    room,
                                    null,
                                    new LeaseReleased(acquired.released().terminalId()));
                        broadcast(room, null, new LeaseGranted(acquired.lease()));
                    }
                }
            }
        }

        @Override
        public void input(InputFrame frame) {
            // Realtime entry, outside JSON dispatch/persistence; same short room lock fences
            // ownership.
            synchronized (room.state) {
                if (!current()) return;
                try {
                    if (member.identity.role() != Role.PARTICIPANT) {
                        reply(new Rejected("bad-message", "input requires a participant session"));
                        return;
                    }
                    var host = terminalHost(frame.terminalId());
                    var rejection =
                            room.control.inputRejection(
                                    member.identity.clientId(),
                                    frame.terminalId(),
                                    frame.leaseId(),
                                    host == null
                                            ? null
                                            : new RoomControl.InputHost(
                                                    host.identity.clientId(),
                                                    host.connected,
                                                    host.host.snapshot().remoteInputAllowed()));
                    if (rejection.isPresent()) {
                        reply(new LeaseInvalid(frame.terminalId(), rejection.get()));
                        return;
                    }
                    try {
                        host.peer.sendInput(frame);
                    } catch (PeerUnavailable unavailable) {
                        // Delivery is uncertain: never retry a command that might already execute.
                        disconnected(room, host.identity, host);
                        host.peer.close();
                        reply(new LeaseInvalid(frame.terminalId(), InputRejection.TERMINAL_CLOSED));
                    }
                } catch (PeerUnavailable unavailable) {
                    disconnect();
                    member.peer.close();
                }
            }
        }

        private ChangeResult openTerminal(String hostId, RoomControl draft) {
            var host = room.members.get(new Identity(Role.HOST, hostId));
            if (host == null || !host.connected)
                return new ChangeResult.Reply(new Rejected("bad-message", "host is offline"));
            try {
                var terminal = draft.openTerminal(hostId);
                return new ChangeResult.HostRequest(host, new OpenTerminal(terminal.terminalId()));
            } catch (TerminalWorkspace.IdsExhausted exhausted) {
                return new ChangeResult.Reply(
                        new Rejected("bad-message", "terminal ID space exhausted"));
            }
        }

        private ChangeResult updateHost(HostCommand command, RoomControl draft) {
            try {
                return switch (command) {
                    case HostCommand.Inventory inventory -> {
                        var runtimes =
                                inventory.terminals().stream()
                                        .map(
                                                item ->
                                                        new TerminalWorkspace.Runtime(
                                                                item.terminalId(),
                                                                item.runtimeId()))
                                        .toList();
                        yield new ChangeResult.Inventory(
                                draft.reconcileTerminals(member.identity.clientId(), runtimes));
                    }
                    case HostCommand.TerminalOpened opened -> {
                        var terminal =
                                draft.confirmTerminalOpened(
                                        member.identity.clientId(),
                                        opened.terminalId(),
                                        opened.runtimeId());
                        yield terminal.isPresent()
                                ? new ChangeResult.Broadcast(new TerminalOpened(terminal.get()))
                                : new ChangeResult.Unchanged();
                    }
                    case HostCommand.TerminalClosed exited ->
                            draft.terminalExited(
                                            member.identity.clientId(),
                                            exited.terminalId(),
                                            exited.exitCode())
                                    ? new ChangeResult.Broadcast(
                                            new TerminalClosed(
                                                    exited.terminalId(), exited.exitCode()))
                                    : new ChangeResult.Unchanged();
                    case HostCommand.TerminalMetadata report ->
                            draft.updateTerminalMetadata(
                                            member.identity.clientId(),
                                            report.terminalId(),
                                            report.metadata())
                                    ? new ChangeResult.Broadcast(
                                            new TerminalMetadataChanged(
                                                    report.terminalId(), report.metadata()))
                                    : new ChangeResult.Unchanged();
                    case HostCommand.ReplayComplete ignored ->
                            throw new IllegalStateException(
                                    "Replay completion changes only live output");
                    case HostCommand.InputState ignored ->
                            throw new IllegalStateException(
                                    "Input permission changes only live presence");
                };
            } catch (TerminalWorkspace.TerminalNotOwned rejected) {
                return new ChangeResult.Reply(
                        new Rejected("bad-message", "host does not own the terminal"));
            }
        }

        private void acknowledgeReplay(HostCommand.ReplayComplete complete) {
            if (!room.control.ownsOpenTerminal(member.identity.clientId(), complete.terminalId())) {
                reply(new Rejected("bad-message", "host does not own an open terminal"));
                return;
            }
            room.output.acknowledge(complete.terminalId(), complete.lastOutputSeq());
            broadcast(room, null, room.output.sync(complete.terminalId()));
        }

        private void reportInputState(HostCommand.InputState input) {
            if (member.host.reportInputState(input.remoteInputAllowed()))
                broadcast(
                        room,
                        null,
                        new HostInputStateChanged(
                                member.identity.clientId(), input.remoteInputAllowed()));
        }

        private void publishInventory(TerminalWorkspace.Reconciliation result) {
            if (current()) member.host.inventoryAccepted();
            try {
                for (var terminalId : result.toClose()) reply(new CloseTerminal(terminalId));
                reply(
                        new HostReady(
                                result.active().stream()
                                        .map(
                                                id ->
                                                        new ReplayPosition(
                                                                id, room.output.sourceSeq(id)))
                                        .toList()));
            } finally {
                if (current()) broadcast(room, null, new HostConnected(member.host.snapshot()));
                for (var terminalId : result.closed())
                    broadcast(room, null, new TerminalClosed(terminalId));
                for (var terminal : result.recovered())
                    broadcast(room, null, new TerminalOpened(terminal));
            }
        }
    }

    private Authenticated authenticate(
            AdmissionRequest request, RoomDirectory.Room room, Peer peer) {
        if (request instanceof Hello legacy) {
            try {
                rooms.authenticatedRoom(legacy.roomId(), legacy.token());
                return new Authenticated(
                        new Identity(legacy.role(), legacy.clientId()), legacy.name());
            } catch (RoomDirectory.InvitationRejected rejected) {
                reject(peer, rejected.code(), rejected.code());
                return null;
            }
        }
        var credential = (CredentialHello) request;
        var subject = rooms.authenticateCredential(room, credential.credential()).orElse(null);
        if (subject == null || subject.role() == RoomCredentials.Role.MANAGER) {
            reject(peer, "invalid-credential", "invalid-credential");
            return null;
        }
        var role =
                switch (subject.role()) {
                    case PARTICIPANT -> Role.PARTICIPANT;
                    case HOST -> Role.HOST;
                    case MANAGER ->
                            throw new IllegalStateException("Manager cannot hold a socket session");
                };
        return new Authenticated(new Identity(role, subject.id()), credential.name());
    }

    private Welcome welcome(Presence room, Member self, String name) {
        var participants =
                room.members.values().stream()
                        .filter(m -> m.identity.role() == Role.PARTICIPANT)
                        .map(this::participant)
                        .toList();
        var hosts = new LinkedHashMap<String, HostPresence.State>();
        for (var host : room.control.hosts())
            hosts.put(
                    host.hostId(),
                    new HostPresence.State(host.hostId(), host.name(), false, false));
        // A connected member supplies live facts over the committed host identity.
        for (var member : room.members.values())
            if (member.host != null) hosts.put(member.identity.clientId(), member.host.snapshot());
        return new Welcome(
                room.roomId,
                name,
                self.identity.clientId(),
                participants,
                List.copyOf(hosts.values()),
                room.control.terminals(),
                room.control.leases());
    }

    private Participant participant(Member member) {
        return new Participant(member.identity.clientId(), member.name, member.focusedTerminalId);
    }

    private void disconnected(Presence room, Identity id, Member member) {
        synchronized (room.state) {
            if (room.members.get(id) != member || !member.connected) return;
            member.connected = false;
            member.restoring.clear();
            if (id.role() == Role.HOST) {
                member.host.disconnected();
                broadcast(room, null, new HostOffline(id.clientId()));
            }
            if (closing || closed) return;
            long grace =
                    id.role() == Role.PARTICIPANT
                            ? policy.participantGraceMs()
                            : policy.hostGraceMs();
            member.expiry =
                    timers.schedule(
                            room.state,
                            () -> expire(room, id, member),
                            grace,
                            TimeUnit.MILLISECONDS);
        }
    }

    /** Revocation shares admission order; a failed save leaves authority and sessions intact. */
    public void revokeCredential(
            String roomId, String managerCredential, RoomCredentials.Subject subject) {
        var state = rooms.roomForAdmission(roomId);
        if (state == null) throw new RoomDirectory.RevocationRejected();
        rooms.execute(
                state,
                operation -> {
                    operation.revokeCredential(
                            managerCredential,
                            subject,
                            removedTerminals -> {
                                var room = presence.get(roomId);
                                if (room == null) return;
                                var role =
                                        subject.role() == RoomCredentials.Role.HOST
                                                ? Role.HOST
                                                : Role.PARTICIPANT;
                                var id = new Identity(role, subject.id());
                                var member = room.members.get(id);
                                if (member != null) member.cancelExpiry();
                                // Remove membership before close: even synchronous disconnect
                                // callbacks are stale.
                                removeMember(room, id, removedTerminals);
                                if (member != null)
                                    reject(member.peer, "invalid-credential", "invalid-credential");
                            });
                    return null;
                });
    }

    private void expire(Presence room, Identity id, Member member) {
        try {
            rooms.execute(
                    room.state,
                    operation -> {
                        var empty =
                                operation.changeIf(
                                        () -> room.members.get(id) == member && !member.connected,
                                        draft ->
                                                id.role() == Role.HOST
                                                        ? draft.removeHost(id.clientId())
                                                        : List.<Long>of(),
                                        removed -> removeMember(room, id, removed));
                        if (Boolean.TRUE.equals(empty)) {
                            operation.remove();
                            presence.remove(room.roomId, room);
                        }
                        return null;
                    });
        } catch (RoomDirectory.Closing stopped) {
            // A due timer that has not entered room ordering is cancelled by shutdown.
            if (!closing) throw stopped;
        } catch (RuntimeException failure) {
            System.getLogger(RoomSessions.class.getName())
                    .log(System.Logger.Level.ERROR, "Room expiry failed: " + room.roomId, failure);
            throw failure;
        }
    }

    /** Updates presence after durable removal; callers decide whether an empty room expires. */
    private boolean removeMember(Presence room, Identity id, List<Long> removedTerminals) {
        var removed = room.members.remove(id);
        if (removed != null) {
            removed.cancelExpiry();
            removed.restoring.clear();
            releaseMember();
        }
        if (id.role() == Role.HOST) removedTerminals.forEach(room.output::remove);
        else
            for (var lease : room.control.removeParticipant(id.clientId()))
                broadcast(room, null, new LeaseReleased(lease.terminalId()));
        broadcast(
                room,
                null,
                id.role() == Role.PARTICIPANT
                        ? new ParticipantLeft(id.clientId())
                        : new HostRemoved(id.clientId()));
        return room.members.isEmpty();
    }

    private void broadcast(Presence room, Member excluded, RoomNotice event) {
        for (var member : List.copyOf(room.members.values())) {
            if (member == excluded
                    || !member.connected
                    || member.identity.role() != Role.PARTICIPANT) continue;
            try {
                member.peer.send(event);
            } catch (PeerUnavailable unavailable) {
                disconnected(room, member.identity, member);
                member.peer.close();
            }
        }
    }

    private static void reject(Peer peer, String code, String message) {
        try {
            peer.send(new Rejected(code, message));
        } catch (PeerUnavailable unavailable) {
            /* Still close a rejected peer if it cannot receive the error. */
        } finally {
            peer.close();
        }
    }

    @Override
    public void close() {
        closing = true;
        rooms.stopAccepting();
        try {
            timers.close();
            rooms.close();
        } finally {
            closed = true;
        }
    }
}

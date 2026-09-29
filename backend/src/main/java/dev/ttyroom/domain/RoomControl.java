package dev.ttyroom.domain;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;

/**
 * Owns terminal and lease consistency within one room. The caller serializes every operation with
 * session changes; sockets, timers and output history stay outside this model.
 */
public final class RoomControl {
    /** Current transport facts, supplied under the room lock rather than stored twice. */
    public record InputHost(String hostId, boolean connected, boolean remoteInputAllowed) {}

    public enum InputRejection {
        TERMINAL_CLOSED,
        REMOTE_INPUT_DISABLED,
        NOT_HOLDER
    }

    public enum TerminalRejection {
        TERMINAL_NOT_FOUND,
        TERMINAL_NOT_OPEN,
        HOST_OFFLINE
    }

    public sealed interface ModeChange {
        record Changed() implements ModeChange {}

        record Unchanged() implements ModeChange {}

        record Rejected(TerminalRejection reason) implements ModeChange {}
    }

    /**
     * Any authenticated participant may change mode. The supplied current host ID is null when
     * disconnected. Mode changes preserve leases, including across a return to exclusive.
     */
    public ModeChange setTerminalMode(
            long terminalId, TerminalWorkspace.Mode mode, String connectedHostId) {
        var rejection = terminalRequestRejection(terminalId, connectedHostId);
        if (rejection.isPresent()) return new ModeChange.Rejected(rejection.get());
        return workspace.setMode(terminalId, mode)
                ? new ModeChange.Changed()
                : new ModeChange.Unchanged();
    }

    /**
     * Shared target policy for mode, close and resize; independent of input permission or lease.
     */
    public Optional<TerminalRejection> terminalRequestRejection(
            long terminalId, String connectedHostId) {
        var terminal = workspace.find(terminalId).orElse(null);
        if (terminal == null) return Optional.of(TerminalRejection.TERMINAL_NOT_FOUND);
        if (terminal.status() != TerminalWorkspace.Status.OPEN)
            return Optional.of(TerminalRejection.TERMINAL_NOT_OPEN);
        if (!terminal.hostId().equals(connectedHostId))
            return Optional.of(TerminalRejection.HOST_OFFLINE);
        return Optional.empty();
    }

    public static final class TerminalUnavailable extends RuntimeException {}

    public record HostIdentity(String hostId, String name) {
        public HostIdentity {
            Objects.requireNonNull(hostId);
            Objects.requireNonNull(name);
        }
    }

    public record DurableState(List<HostIdentity> hosts, TerminalWorkspace.DurableState workspace) {
        public DurableState {
            hosts = List.copyOf(hosts);
            Objects.requireNonNull(workspace);
            var hostIds = new HashSet<String>();
            for (var host : hosts)
                if (!hostIds.add(host.hostId()))
                    throw new IllegalArgumentException("Duplicate host ID");
            for (var terminal : workspace.terminals())
                if (!hostIds.contains(terminal.view().hostId()))
                    throw new IllegalArgumentException("Terminal host is not registered");
        }
    }

    private final LinkedHashMap<String, HostIdentity> hosts = new LinkedHashMap<>();
    private TerminalWorkspace workspace;

    public RoomControl() {
        this(new TerminalWorkspace());
    }

    private RoomControl(TerminalWorkspace workspace) {
        this.workspace = workspace;
    }

    /** Restores only durable facts; leases and their ID sequence start fresh. */
    public static RoomControl restore(DurableState state) {
        var room = new RoomControl(TerminalWorkspace.restore(state.workspace()));
        state.hosts().forEach(host -> room.hosts.put(host.hostId(), host));
        return room;
    }

    public DurableState durableState() {
        return new DurableState(hosts(), workspace.durableState());
    }

    /**
     * Caller serializes control mutations through commit/discard. Connection and output state are
     * not in this model, so concurrent disconnects and output never get overwritten by commit.
     */
    public <T> Change<T> stageChange(Function<RoomControl, T> change) {
        var draft = new RoomControl(workspace.copy());
        draft.hosts.putAll(hosts);
        draft.leases = leases.copy();
        var before = durableState();
        var result = change.apply(draft);
        var after = draft.durableState();
        return new Change<>(draft, result, before.equals(after) ? null : after);
    }

    public final class Change<T> {
        private final RoomControl draft;
        private final T result;
        private final DurableState recordToSave;
        private boolean committed;

        private Change(RoomControl draft, T result, DurableState recordToSave) {
            this.draft = draft;
            this.result = result;
            this.recordToSave = recordToSave;
        }

        public T result() {
            return result;
        }

        public DurableState recordToSave() {
            return recordToSave;
        }

        public void commit() {
            if (committed) throw new IllegalStateException("Change already committed");
            workspace = draft.workspace;
            leases = draft.leases;
            hosts.clear();
            hosts.putAll(draft.hosts);
            committed = true;
        }
    }

    public void rememberHost(String hostId, String name) {
        hosts.put(hostId, new HostIdentity(hostId, name));
    }

    public List<HostIdentity> hosts() {
        return List.copyOf(hosts.values());
    }

    private LeaseControl leases = new LeaseControl();

    /** Acquisition does not require a connected host or permission to send input. */
    public LeaseControl.Acquisition acquireLease(String participantId, long terminalId) {
        var terminal = workspace.find(terminalId).orElse(null);
        if (terminal == null
                || terminal.status() != TerminalWorkspace.Status.OPEN
                || terminal.mode() != TerminalWorkspace.Mode.EXCLUSIVE)
            throw new TerminalUnavailable();
        return leases.acquire(participantId, terminalId);
    }

    /**
     * An absent host is passed as null. Rejection order is part of the existing input contract:
     * unavailable terminal/connection, host permission, then lease ownership. Display online state
     * is deliberately not a prerequisite. The caller must authenticate the participant. An empty
     * result permits input, not its delivery.
     */
    public Optional<InputRejection> inputRejection(
            String participantId, long terminalId, long leaseId, InputHost host) {
        var terminal = workspace.find(terminalId).orElse(null);
        if (terminal == null
                || terminal.status() != TerminalWorkspace.Status.OPEN
                || host == null
                || !host.connected()
                || !terminal.hostId().equals(host.hostId()))
            return Optional.of(InputRejection.TERMINAL_CLOSED);
        if (!host.remoteInputAllowed()) return Optional.of(InputRejection.REMOTE_INPUT_DISABLED);
        boolean allowed =
                switch (terminal.mode()) {
                    case SHARED -> true;
                    case EXCLUSIVE -> leases.isHeldBy(participantId, terminalId, leaseId);
                };
        if (!allowed) return Optional.of(InputRejection.NOT_HOLDER);
        return Optional.empty();
    }

    /** Removes the host's terminals and their leases together; returns IDs for output cleanup. */
    public List<Long> removeHost(String hostId) {
        hosts.remove(hostId);
        var removed = workspace.removeHost(hostId);
        leases.removeTerminals(removed);
        return List.copyOf(removed);
    }

    public boolean releaseLease(String participantId, long terminalId, long leaseId) {
        return leases.release(participantId, terminalId, leaseId);
    }

    public List<LeaseControl.Lease> removeParticipant(String participantId) {
        return leases.releaseAllOf(participantId);
    }

    public List<LeaseControl.Lease> leases() {
        return leases.snapshot();
    }

    public List<TerminalWorkspace.Terminal> terminals() {
        return workspace.snapshot();
    }

    public Optional<TerminalWorkspace.Terminal> terminal(long terminalId) {
        return workspace.find(terminalId);
    }

    public boolean ownsOpenTerminal(String hostId, long terminalId) {
        return workspace.ownsOpen(hostId, terminalId);
    }

    /** Registration is durable identity; connection availability remains an application policy. */
    public TerminalWorkspace.Terminal openTerminal(String hostId) {
        requireRegisteredHost(hostId);
        return workspace.open(hostId);
    }

    public Optional<TerminalWorkspace.Terminal> confirmTerminalOpened(
            String hostId, long terminalId, String runtimeId) {
        return workspace.confirmOpened(hostId, terminalId, runtimeId);
    }

    /** Exit and inventory loss retain leases; explicit release or member removal ends them. */
    public boolean terminalExited(String hostId, long terminalId, Double exitCode) {
        return workspace.markExited(hostId, terminalId, exitCode);
    }

    public TerminalWorkspace.Reconciliation reconcileTerminals(
            String hostId, List<TerminalWorkspace.Runtime> inventory) {
        requireRegisteredHost(hostId);
        return workspace.reconcile(hostId, inventory);
    }

    private void requireRegisteredHost(String hostId) {
        if (!hosts.containsKey(hostId))
            throw new IllegalArgumentException("Host is not registered");
    }

    /** View edits need only an existing terminal, including pending, exited or offline ones. */
    public boolean renameTerminal(long terminalId, String title) {
        return workspace.rename(terminalId, title);
    }

    /** True means accepted, even when geometry is unchanged. Does not affect PTY size or leases. */
    public boolean updateTerminalGeometry(long terminalId, TerminalWorkspace.Geometry geometry) {
        return workspace.updateGeometry(terminalId, geometry);
    }

    public boolean updateTerminalMetadata(
            String hostId, long terminalId, TerminalWorkspace.Metadata metadata) {
        return workspace.updateMetadata(hostId, terminalId, metadata);
    }
}

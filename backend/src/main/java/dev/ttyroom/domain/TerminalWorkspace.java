package dev.ttyroom.domain;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/** Owns terminal identity and reconciliation. Its room owner serializes mutations. */
public final class TerminalWorkspace {
    public enum Status {
        OPEN,
        EXITED
    }

    public enum Mode {
        EXCLUSIVE,
        SHARED
    }

    public record Geometry(double x, double y, double width, double height) {}

    public record Metadata(String cwd, String gitBranch, String fgProcess) {}

    /** Immutable public view. OPEN includes a reservation awaiting its runtime. */
    public record Terminal(
            long terminalId,
            String hostId,
            String title,
            Geometry geometry,
            Mode mode,
            Status status,
            Double exitCode,
            Metadata meta) {}

    /** Durable projection; a null runtime on an OPEN view represents a pending reservation. */
    public record StoredTerminal(Terminal view, String runtimeId) {
        public StoredTerminal {
            Objects.requireNonNull(view);
            Objects.requireNonNull(view.hostId());
            Objects.requireNonNull(view.title());
            Objects.requireNonNull(view.geometry());
            Objects.requireNonNull(view.mode());
            Objects.requireNonNull(view.status());
            Objects.requireNonNull(view.meta());
            if (view.terminalId() < 0 || view.terminalId() > 0xffff_ffffL)
                throw new IllegalArgumentException("Terminal ID is outside u32");
            if (view.status() == Status.OPEN && view.exitCode() != null)
                throw new IllegalArgumentException("Open terminal cannot have an exit result");
            if (view.status() == Status.EXITED && runtimeId != null)
                throw new IllegalArgumentException("Exited terminal cannot retain a runtime");
        }
    }

    /** No confirmation history or live input/output state crosses this boundary. */
    public record DurableState(long nextTerminalId, List<StoredTerminal> terminals) {
        public DurableState {
            terminals = List.copyOf(terminals);
            if (nextTerminalId < 1 || nextTerminalId > 0x1_0000_0000L)
                throw new IllegalArgumentException("Invalid next terminal ID");
            var ids = new HashSet<Long>();
            for (var terminal : terminals) {
                long id = terminal.view().terminalId();
                if (!ids.add(id) || id >= nextTerminalId)
                    throw new IllegalArgumentException("Duplicate or unallocated terminal ID");
            }
        }
    }

    public record Runtime(long terminalId, String runtimeId) {}

    public record Reconciliation(
            List<Long> active, List<Long> closed, List<Long> toClose, List<Terminal> recovered) {
        public Reconciliation {
            active = List.copyOf(active);
            closed = List.copyOf(closed);
            toClose = List.copyOf(toClose);
            recovered = List.copyOf(recovered);
        }
    }

    private sealed interface Lifecycle {}

    private record Pending() implements Lifecycle {}

    private record Running(String runtimeId) implements Lifecycle {
        Running {
            Objects.requireNonNull(runtimeId);
        }
    }

    /**
     * A null exit code means no exit result is known, including creation failure or inventory loss.
     */
    private record Exited(Double exitCode) implements Lifecycle {}

    /** Owns transitions; status and exitCode are projections, never separately stored state. */
    private static final class Entry {
        final long terminalId;
        final String hostId;
        String title;
        Geometry geometry;
        Mode mode = Mode.EXCLUSIVE;
        Metadata metadata = new Metadata(null, null, null);
        Lifecycle lifecycle;

        Entry(long terminalId, String hostId, Lifecycle lifecycle) {
            this.terminalId = terminalId;
            this.hostId = hostId;
            this.title = "term-" + terminalId;
            // Recovered IDs span u32; workspace coordinates have a smaller wire range.
            double position = Math.min(0xffff, 24 + (terminalId - 1) * 32.0);
            this.geometry = new Geometry(position, position, 640, 420);
            this.lifecycle = lifecycle;
        }

        Entry(StoredTerminal stored) {
            var view = stored.view();
            terminalId = view.terminalId();
            hostId = view.hostId();
            title = view.title();
            geometry = view.geometry();
            mode = view.mode();
            metadata = view.meta();
            lifecycle =
                    switch (view.status()) {
                        case EXITED -> new Exited(view.exitCode());
                        case OPEN ->
                                stored.runtimeId() == null
                                        ? new Pending()
                                        : new Running(stored.runtimeId());
                    };
        }

        StoredTerminal durableState() {
            return new StoredTerminal(
                    snapshot(), lifecycle instanceof Running running ? running.runtimeId() : null);
        }

        boolean isOpen() {
            return switch (lifecycle) {
                case Pending pending -> true;
                case Running running -> true;
                case Exited exited -> false;
            };
        }

        boolean attachRuntime(String runtimeId) {
            if (!isOpen()) return false;
            lifecycle = new Running(runtimeId);
            return true;
        }

        boolean markExited(Double exitCode) {
            if (!isOpen()) return false;
            lifecycle = new Exited(exitCode);
            return true;
        }

        /** A reservation accepts any reported runtime; an attached runtime must still match. */
        boolean reconcile(Runtime reported) {
            if (!isOpen()) return false;
            boolean matches =
                    reported != null
                            && switch (lifecycle) {
                                case Pending pending -> true;
                                case Running running ->
                                        running.runtimeId().equals(reported.runtimeId());
                                case Exited exited -> false;
                            };
            if (matches) attachRuntime(reported.runtimeId());
            else markExited(null);
            return matches;
        }

        Terminal snapshot() {
            return switch (lifecycle) {
                case Pending pending -> snapshot(Status.OPEN, null);
                case Running running -> snapshot(Status.OPEN, null);
                case Exited exited -> snapshot(Status.EXITED, exited.exitCode());
            };
        }

        private Terminal snapshot(Status status, Double exitCode) {
            return new Terminal(
                    terminalId, hostId, title, geometry, mode, status, exitCode, metadata);
        }
    }

    private final LinkedHashMap<Long, Entry> terminals = new LinkedHashMap<>();
    private long nextTerminalId = 1;
    // Inventory binding/recovery does not consume the first explicit opening confirmation.
    private final Set<Long> confirmedOpenings = new HashSet<>();

    /** Command drafts keep transient confirmation history, unlike restart restoration. */
    TerminalWorkspace copy() {
        var copy = restore(durableState());
        copy.confirmedOpenings.addAll(confirmedOpenings);
        return copy;
    }

    public DurableState durableState() {
        return new DurableState(
                nextTerminalId, terminals.values().stream().map(Entry::durableState).toList());
    }

    public static TerminalWorkspace restore(DurableState state) {
        var workspace = new TerminalWorkspace();
        workspace.nextTerminalId = state.nextTerminalId();
        for (var terminal : state.terminals()) {
            var entry = new Entry(terminal);
            workspace.terminals.put(entry.terminalId, entry);
        }
        return workspace;
    }

    public static final class IdsExhausted extends RuntimeException {}

    public static final class TerminalNotOwned extends RuntimeException {}

    /** Reserves an open view before the Connector confirms its runtime, matching v7 snapshots. */
    public Terminal open(String hostId) {
        if (nextTerminalId > 0xffff_ffffL) throw new IdsExhausted();
        var entry = new Entry(nextTerminalId++, hostId, new Pending());
        terminals.put(entry.terminalId, entry);
        return entry.snapshot();
    }

    /** Repeated confirmations can update the runtime but announce an opening only once. */
    public Optional<Terminal> confirmOpened(String hostId, long terminalId, String runtimeId) {
        var entry = ownedTerminal(hostId, terminalId);
        if (!entry.attachRuntime(runtimeId)) return Optional.empty();
        return confirmedOpenings.add(terminalId) ? Optional.of(entry.snapshot()) : Optional.empty();
    }

    public boolean markExited(String hostId, long terminalId, Double exitCode) {
        return ownedTerminal(hostId, terminalId).markExited(exitCode);
    }

    /** Late reports may update exited terminals; metadata never changes runtime or lifecycle. */
    public boolean updateMetadata(String hostId, long terminalId, Metadata metadata) {
        var entry = ownedTerminal(hostId, terminalId);
        if (entry.metadata.equals(metadata)) return false;
        entry.metadata = metadata;
        return true;
    }

    /** View edits are independent of runtime lifecycle; an unchanged title has no event. */
    boolean rename(long terminalId, String title) {
        Objects.requireNonNull(title);
        var entry = terminals.get(terminalId);
        if (entry == null || entry.title.equals(title)) return false;
        entry.title = title;
        return true;
    }

    /** Returns acceptance, including repeated geometry, so each accepted request is published. */
    boolean updateGeometry(long terminalId, Geometry geometry) {
        Objects.requireNonNull(geometry);
        var entry = terminals.get(terminalId);
        if (entry == null) return false;
        entry.geometry = geometry;
        return true;
    }

    boolean setMode(long terminalId, Mode mode) {
        Objects.requireNonNull(mode);
        var entry = terminals.get(terminalId);
        if (entry == null || !entry.isOpen() || entry.mode == mode) return false;
        entry.mode = mode;
        return true;
    }

    private Entry ownedTerminal(String hostId, long terminalId) {
        var entry = terminals.get(terminalId);
        if (entry == null || !entry.hostId.equals(hostId)) throw new TerminalNotOwned();
        return entry;
    }

    public Reconciliation reconcile(String hostId, List<Runtime> inventory) {
        var reported = new LinkedHashMap<Long, Runtime>();
        inventory.forEach(item -> reported.put(item.terminalId(), item));
        var active = new ArrayList<Long>();
        var closed = new ArrayList<Long>();
        var toClose = new LinkedHashSet<Long>();
        var recovered = new ArrayList<Terminal>();
        for (var entry : terminals.values()) {
            if (!entry.hostId.equals(hostId) || !entry.isOpen()) continue;
            var item = reported.remove(entry.terminalId);
            if (entry.reconcile(item)) {
                active.add(entry.terminalId);
            } else {
                closed.add(entry.terminalId);
                if (item != null) toClose.add(entry.terminalId);
            }
        }
        for (var item : reported.values()) {
            if (terminals.containsKey(item.terminalId())) {
                toClose.add(item.terminalId());
                continue;
            }
            var entry = new Entry(item.terminalId(), hostId, new Running(item.runtimeId()));
            nextTerminalId = Math.max(nextTerminalId, item.terminalId() + 1);
            terminals.put(item.terminalId(), entry);
            active.add(item.terminalId());
            recovered.add(entry.snapshot());
        }
        return new Reconciliation(active, closed, new ArrayList<>(toClose), recovered);
    }

    public boolean ownsOpen(String hostId, long terminalId) {
        var entry = terminals.get(terminalId);
        return entry != null && entry.hostId.equals(hostId) && entry.isOpen();
    }

    public Optional<Terminal> find(long terminalId) {
        var entry = terminals.get(terminalId);
        return entry == null ? Optional.empty() : Optional.of(entry.snapshot());
    }

    public boolean contains(long terminalId) {
        return terminals.containsKey(terminalId);
    }

    public List<Terminal> snapshot() {
        return terminals.values().stream().map(Entry::snapshot).toList();
    }

    public List<Long> removeHost(String hostId) {
        var removed = new ArrayList<Long>();
        terminals
                .entrySet()
                .removeIf(
                        entry -> {
                            if (!entry.getValue().hostId.equals(hostId)) return false;
                            removed.add(entry.getKey());
                            return true;
                        });
        return removed;
    }
}

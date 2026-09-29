package dev.ttyroom.application;

import dev.ttyroom.domain.TerminalWorkspace;

import java.util.List;

/** Validated host reports; wire parsing belongs to the WebSocket adapter. */
public sealed interface HostCommand {
    record Runtime(long terminalId, String runtimeId, long firstRetainedSeq, long lastOutputSeq) {}

    record Inventory(List<Runtime> terminals) implements HostCommand {
        public Inventory {
            terminals = List.copyOf(terminals);
        }
    }

    record ReplayComplete(long terminalId, long lastOutputSeq) implements HostCommand {}

    record TerminalOpened(long terminalId, String runtimeId) implements HostCommand {}

    record TerminalClosed(long terminalId, Double exitCode) implements HostCommand {}

    record TerminalMetadata(long terminalId, TerminalWorkspace.Metadata metadata)
            implements HostCommand {}

    record InputState(boolean remoteInputAllowed) implements HostCommand {}
}

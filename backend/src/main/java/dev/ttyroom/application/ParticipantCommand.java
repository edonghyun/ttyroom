package dev.ttyroom.application;

import dev.ttyroom.domain.TerminalWorkspace.Geometry;
import dev.ttyroom.domain.TerminalWorkspace.Mode;

/** Validated participant requests, separate from host reports and binary output. */
public sealed interface ParticipantCommand {
    record FocusTerminal(Long terminalId) implements ParticipantCommand {}

    record MoveCursor(CursorPosition position) implements ParticipantCommand {}

    record RenameTerminal(long terminalId, String title) implements ParticipantCommand {}

    record UpdateTerminalGeometry(long terminalId, Geometry geometry)
            implements ParticipantCommand {}

    record SetTerminalMode(long terminalId, Mode mode) implements ParticipantCommand {}

    record CloseTerminal(long terminalId) implements ParticipantCommand {}

    record ResizeTerminal(long terminalId, int cols, int rows) implements ParticipantCommand {}

    record OpenTerminal(String hostId) implements ParticipantCommand {}

    record AcquireLease(long terminalId) implements ParticipantCommand {}

    record ReleaseLease(long terminalId, long leaseId) implements ParticipantCommand {}

    record ResyncOutput(long terminalId) implements ParticipantCommand {}
}

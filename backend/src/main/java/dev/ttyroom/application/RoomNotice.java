package dev.ttyroom.application;

import dev.ttyroom.domain.HostPresence;
import dev.ttyroom.domain.LeaseControl;
import dev.ttyroom.domain.RoomControl.InputRejection;
import dev.ttyroom.domain.RoomControl.TerminalRejection;
import dev.ttyroom.domain.TerminalWorkspace;

import java.util.List;

/** Immutable session results. Wire envelopes and JSON field names belong to the adapter. */
public sealed interface RoomNotice {
    record Participant(String clientId, String name, Long focusedTerminalId) {}

    record Welcome(
            String roomId,
            String roomName,
            String selfClientId,
            List<Participant> participants,
            List<HostPresence.State> hosts,
            List<TerminalWorkspace.Terminal> terminals,
            List<LeaseControl.Lease> leases)
            implements RoomNotice {
        public Welcome {
            participants = List.copyOf(participants);
            hosts = List.copyOf(hosts);
            terminals = List.copyOf(terminals);
            leases = List.copyOf(leases);
        }
    }

    record ParticipantJoined(Participant participant) implements RoomNotice {}

    record ParticipantLeft(String clientId) implements RoomNotice {}

    record ParticipantFocusChanged(String clientId, Long focusedTerminalId) implements RoomNotice {}

    record ParticipantCursor(String clientId, CursorPosition position) implements RoomNotice {}

    record HostOffline(String hostId) implements RoomNotice {}

    record HostRemoved(String hostId) implements RoomNotice {}

    record ReplayPosition(long terminalId, long replayAfterSeq) {}

    record HostReady(List<ReplayPosition> terminals) implements RoomNotice {
        public HostReady {
            terminals = List.copyOf(terminals);
        }
    }

    record OpenTerminal(long terminalId) implements RoomNotice {}

    record CloseTerminal(long terminalId) implements RoomNotice {}

    record ResizeTerminal(long terminalId, int cols, int rows) implements RoomNotice {}

    record TerminalCloseRejected(long terminalId, TerminalRejection reason) implements RoomNotice {}

    record TerminalOpened(TerminalWorkspace.Terminal terminal) implements RoomNotice {}

    record TerminalClosed(long terminalId, Double exitCode) implements RoomNotice {
        public TerminalClosed(long terminalId) {
            this(terminalId, null);
        }
    }

    record TerminalMetadataChanged(long terminalId, TerminalWorkspace.Metadata metadata)
            implements RoomNotice {}

    record TerminalRenamed(long terminalId, String title) implements RoomNotice {}

    record TerminalGeometryChanged(long terminalId, TerminalWorkspace.Geometry geometry)
            implements RoomNotice {}

    record TerminalModeChanged(long terminalId, TerminalWorkspace.Mode mode)
            implements RoomNotice {}

    record TerminalModeRejected(long terminalId, TerminalRejection reason) implements RoomNotice {}

    record LeaseAccepted(long terminalId, long leaseId) implements RoomNotice {}

    record LeaseDenied(long terminalId, String holderClientId) implements RoomNotice {}

    record LeaseInvalid(long terminalId, InputRejection reason) implements RoomNotice {}

    record LeaseGranted(LeaseControl.Lease lease) implements RoomNotice {}

    record LeaseReleased(long terminalId) implements RoomNotice {}

    record Sync(long terminalId, long seq) implements RoomNotice {}

    record OutputGap(long terminalId, long fromSeq, long toSeq) implements RoomNotice {}

    record ResyncRejected(long terminalId) implements RoomNotice {}

    record HostConnected(HostPresence.State host) implements RoomNotice {}

    record HostInputStateChanged(String hostId, boolean remoteInputAllowed) implements RoomNotice {}

    record Rejected(String code, String message) implements RoomNotice {}
}

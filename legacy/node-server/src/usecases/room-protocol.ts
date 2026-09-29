import type {
  HostView,
  LeaseView,
  ParticipantView,
  RoomSnapshot,
  TerminalView,
} from "@ttyroom/protocol";
import type {
  HostState,
  Lease,
  ParticipantState,
  RoomState,
  TerminalState,
} from "../domain/room.js";

export function toRoomSnapshot(state: RoomState): RoomSnapshot {
  return {
    roomId: state.roomId,
    name: state.name,
    participants: state.participants.map(toParticipantView),
    hosts: state.hosts.map(toHostView),
    terminals: state.terminals.map(toTerminalView),
    leases: state.leases.map(toLeaseView),
  };
}

export function toParticipantView(participant: ParticipantState): ParticipantView {
  return {
    clientId: participant.clientId,
    name: participant.name,
    focusedTerminalId: participant.focusedTerminalId,
  };
}

export function toHostView(host: HostState): HostView {
  return {
    hostId: host.hostId,
    name: host.name,
    online: host.online,
    remoteInputAllowed: host.remoteInputAllowed,
  };
}

export function toTerminalView(terminal: TerminalState): TerminalView {
  return {
    terminalId: terminal.terminalId,
    hostId: terminal.hostId,
    title: terminal.title,
    geometry: { ...terminal.geometry },
    mode: terminal.mode,
    status: terminal.status,
    exitCode: terminal.exitCode,
    meta: { ...terminal.meta },
  };
}

export function toLeaseView(lease: Lease): LeaseView {
  return {
    terminalId: lease.terminalId,
    leaseId: lease.leaseId,
    holderClientId: lease.holderClientId,
  };
}

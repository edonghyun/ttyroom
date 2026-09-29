import type { RoomEvent } from "@ttyroom/protocol";
import type {
  HostState,
  Lease,
  ParticipantState,
  TerminalGeometry,
  TerminalMetadata,
  TerminalState,
} from "../domain/room.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { toHostView, toLeaseView, toParticipantView, toTerminalView } from "./room-protocol.js";

export type RoomChange =
  | { kind: "participant-joined"; participant: ParticipantState }
  | { kind: "participant-left"; clientId: string }
  | {
      kind: "participant-focus-changed";
      clientId: string;
      focusedTerminalId: number | null;
    }
  | { kind: "host-connected"; host: HostState }
  | { kind: "host-offline"; hostId: string }
  | { kind: "host-removed"; hostId: string }
  | { kind: "host-input-state-changed"; hostId: string; remoteInputAllowed: boolean }
  | { kind: "terminal-opened"; terminal: TerminalState }
  | { kind: "terminal-mode-changed"; terminalId: number; mode: "exclusive" | "shared" }
  | { kind: "terminal-geometry-changed"; terminalId: number; geometry: TerminalGeometry }
  | { kind: "terminal-renamed"; terminalId: number; title: string }
  | { kind: "terminal-closed"; terminalId: number; exitCode: number | null }
  | { kind: "lease-granted"; lease: Lease }
  | { kind: "lease-released"; terminalId: number }
  | { kind: "terminal-meta"; terminalId: number; meta: TerminalMetadata };

export class RoomEventPublisher {
  constructor(private readonly connections: ConnectionRegistry) {}

  publish(roomId: string, change: RoomChange): void {
    this.connections.broadcast(roomId, {
      type: "room-event",
      event: toRoomEvent(change),
    });
  }
}

function toRoomEvent(change: RoomChange): RoomEvent {
  switch (change.kind) {
    case "participant-joined":
      return { kind: change.kind, participant: toParticipantView(change.participant) };
    case "host-connected":
      return { kind: change.kind, host: toHostView(change.host) };
    case "terminal-opened":
      return { kind: change.kind, terminal: toTerminalView(change.terminal) };
    case "lease-granted":
      return { kind: change.kind, lease: toLeaseView(change.lease) };
    case "terminal-geometry-changed":
      return {
        kind: change.kind,
        terminalId: change.terminalId,
        geometry: { ...change.geometry },
      };
    case "terminal-meta":
      return { kind: change.kind, terminalId: change.terminalId, meta: { ...change.meta } };
    case "participant-left":
      return { kind: change.kind, clientId: change.clientId };
    case "participant-focus-changed":
      return {
        kind: change.kind,
        clientId: change.clientId,
        focusedTerminalId: change.focusedTerminalId,
      };
    case "host-offline":
    case "host-removed":
      return { kind: change.kind, hostId: change.hostId };
    case "host-input-state-changed":
      return {
        kind: change.kind,
        hostId: change.hostId,
        remoteInputAllowed: change.remoteInputAllowed,
      };
    case "terminal-mode-changed":
      return {
        kind: change.kind,
        terminalId: change.terminalId,
        mode: change.mode,
      };
    case "terminal-renamed":
      return {
        kind: change.kind,
        terminalId: change.terminalId,
        title: change.title,
      };
    case "terminal-closed":
      return {
        kind: change.kind,
        terminalId: change.terminalId,
        exitCode: change.exitCode,
      };
    case "lease-released":
      return { kind: change.kind, terminalId: change.terminalId };
  }
  return assertNever(change);
}

function assertNever(value: never): never {
  throw new Error(`처리되지 않은 Room change: ${JSON.stringify(value)}`);
}

import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class SetTerminalMode {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  async execute(
    requester: Connection,
    session: Session,
    terminalId: number,
    mode: "exclusive" | "shared",
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    if (!room || !terminal) {
      requester.send({
        type: "terminal-request-rejected",
        request: "set-mode",
        terminalId,
        reason: "terminal-not-found",
      });
      return;
    }
    if (terminal.status !== "open") {
      requester.send({
        type: "terminal-request-rejected",
        request: "set-mode",
        terminalId,
        reason: "terminal-not-open",
      });
      return;
    }
    if (!this.deps.connections.hostSession(room.roomId, terminal.hostId)) {
      requester.send({
        type: "terminal-request-rejected",
        request: "set-mode",
        terminalId,
        reason: "host-offline",
      });
      return;
    }
    const changed = await this.deps.rooms.change(room, (draft) =>
      draft.setTerminalMode(terminalId, mode),
    );
    if (!changed) return;

    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "terminal-mode-changed", terminalId, mode },
    });
  }
}

import type { TerminalGeometry } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class UpdateTerminalGeometry {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(session: Session, terminalId: number, geometry: TerminalGeometry): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room?.terminal(terminalId)) return;

    room.updateTerminalGeometry(terminalId, geometry);
    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "terminal-geometry-changed", terminalId, geometry },
    });
  }
}

import type { TerminalGeometry } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class UpdateTerminalGeometry {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  async execute(session: Session, terminalId: number, geometry: TerminalGeometry): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room?.terminal(terminalId)) return;

    await this.deps.rooms.change(room, (draft) =>
      draft.updateTerminalGeometry(terminalId, geometry),
    );
    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "terminal-geometry-changed", terminalId, geometry },
    });
  }
}

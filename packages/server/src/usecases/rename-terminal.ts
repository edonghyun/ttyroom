import type { RoomRegistry } from "../domain/room-registry.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class RenameTerminal {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(session: Session, terminalId: number, title: string): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room?.terminal(terminalId)) return;
    if (!room.renameTerminal(terminalId, title)) return;

    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "terminal-renamed", terminalId, title },
    });
  }
}

import type { RoomRegistry } from "../domain/room-registry.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class RenameTerminal {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  async execute(session: Session, terminalId: number, title: string): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room?.terminal(terminalId)) return;
    const changed = await this.deps.rooms.change(room, (draft) =>
      draft.renameTerminal(terminalId, title),
    );
    if (!changed) return;

    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "terminal-renamed", terminalId, title },
    });
  }
}

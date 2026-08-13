import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class FocusParticipant {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(requester: Connection, session: Session, terminalId: number | null): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) return;

    const result = room.focusParticipant(session.clientId, terminalId);
    if (result === "rejected") {
      requester.send({
        type: "error",
        code: "bad-message",
        message: `존재하지 않는 터미널 focus: ${terminalId}`,
      });
      return;
    }
    if (result === "unchanged") return;

    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: {
        kind: "participant-focus-changed",
        clientId: session.clientId,
        focusedTerminalId: terminalId,
      },
    });
  }
}

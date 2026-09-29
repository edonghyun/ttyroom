import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, ParticipantSession } from "./connection-registry.js";

export class ResizeTerminal {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(
    requester: Connection,
    session: ParticipantSession,
    terminalId: number,
    cols: number,
    rows: number,
  ): void {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    const host =
      room && terminal
        ? this.deps.connections.hostSession(room.roomId, terminal.hostId)
        : undefined;
    if (!terminal || terminal.status !== "open" || !host) {
      requester.send({
        type: "error",
        code: "bad-message",
        message: "열린 터미널의 online host가 없다",
      });
      return;
    }

    host.connection.send({ type: "resize", terminalId, cols, rows });
  }
}

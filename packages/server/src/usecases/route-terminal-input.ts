import type { InputFrame } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class RouteTerminalInput {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(connection: Connection, session: Session, frame: InputFrame): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) throw new Error(`등록된 세션의 Room이 없다: ${session.roomId}`);

    const terminal = room.terminal(frame.terminalId);
    const host = terminal
      ? this.deps.connections.hostSession(room.roomId, terminal.hostId)
      : undefined;
    if (!terminal || terminal.status !== "open" || !host) {
      connection.send({
        type: "lease-invalid",
        terminalId: frame.terminalId,
        reason: "terminal-closed",
      });
      return;
    }

    if (!room.isInputAllowed(session.clientId, frame.terminalId, frame.leaseId)) {
      connection.send({
        type: "lease-invalid",
        terminalId: frame.terminalId,
        reason: "not-holder",
      });
      return;
    }

    host.connection.sendData(frame);
  }
}

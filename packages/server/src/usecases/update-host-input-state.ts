import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class UpdateHostInputState {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(connection: Connection, session: Session, remoteInputAllowed: boolean): void {
    const room = this.deps.rooms.get(session.roomId);
    const hostId = session.hostId;
    if (!room || !hostId) {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "등록된 host 세션이 아니다",
      });
      return;
    }

    const changed = room.setHostRemoteInputAllowed(hostId, remoteInputAllowed);
    if (!changed) return;

    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "host-input-state-changed", hostId, remoteInputAllowed },
    });
  }
}

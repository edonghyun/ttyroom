import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class ReleaseLease {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(connection: Connection, session: Session, terminalId: number, leaseId: number): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) throw new Error(`등록된 세션의 Room이 없다: ${session.roomId}`);

    const lease = room.leaseOf(terminalId);
    if (
      !lease ||
      lease.holderClientId !== session.clientId ||
      lease.leaseId !== leaseId ||
      room.releaseLease(session.clientId, terminalId).kind !== "released"
    ) {
      connection.send({ type: "lease-invalid", terminalId, reason: "not-holder" });
      return;
    }

    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "lease-released", terminalId },
    });
  }
}

import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

export class AcquireLease {
  constructor(private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry }) {}

  execute(connection: Connection, session: Session, terminalId: number): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) throw new Error(`등록된 세션의 Room이 없다: ${session.roomId}`);

    const decision = room.acquireLease(session.clientId, terminalId);
    if (decision.kind === "denied") {
      connection.send({
        type: "lease-result",
        terminalId,
        result: { kind: "denied", holderClientId: decision.holderClientId },
      });
      return;
    }

    if (decision.kind === "already-held") {
      connection.send({
        type: "lease-result",
        terminalId,
        result: { kind: "granted", leaseId: decision.lease.leaseId },
      });
      return;
    }

    if (decision.kind === "rejected") {
      connection.send({ type: "lease-invalid", terminalId, reason: "terminal-closed" });
      return;
    }

    connection.send({
      type: "lease-result",
      terminalId,
      result: { kind: "granted", leaseId: decision.lease.leaseId },
    });
    if (decision.autoReleased) {
      this.deps.connections.broadcast(room.roomId, {
        type: "room-event",
        event: { kind: "lease-released", terminalId: decision.autoReleased.terminalId },
      });
    }
    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "lease-granted", lease: decision.lease },
    });
  }
}

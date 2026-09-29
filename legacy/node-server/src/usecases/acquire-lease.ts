import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ParticipantSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class AcquireLease {
  constructor(private readonly deps: { rooms: RoomRegistry; events: RoomEventPublisher }) {}

  async execute(
    connection: Connection,
    session: ParticipantSession,
    terminalId: number,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) throw new Error(`등록된 세션의 Room이 없다: ${session.roomId}`);

    const decision = await this.deps.rooms.change(room, (draft) =>
      draft.acquireLease(session.clientId, terminalId),
    );
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
      this.deps.events.publish(room.roomId, {
        kind: "lease-released",
        terminalId: decision.autoReleased.terminalId,
      });
    }
    this.deps.events.publish(room.roomId, { kind: "lease-granted", lease: decision.lease });
  }
}

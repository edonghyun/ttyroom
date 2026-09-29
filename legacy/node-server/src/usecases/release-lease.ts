import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ParticipantSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class ReleaseLease {
  constructor(private readonly deps: { rooms: RoomRegistry; events: RoomEventPublisher }) {}

  async execute(
    connection: Connection,
    session: ParticipantSession,
    terminalId: number,
    leaseId: number,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) throw new Error(`등록된 세션의 Room이 없다: ${session.roomId}`);

    const released = await this.deps.rooms.change(room, (draft) => {
      const lease = draft.leaseOf(terminalId);
      if (!lease || lease.holderClientId !== session.clientId || lease.leaseId !== leaseId) {
        return false;
      }
      return draft.releaseLease(session.clientId, terminalId).kind === "released";
    });
    if (!released) {
      connection.send({ type: "lease-invalid", terminalId, reason: "not-holder" });
      return;
    }

    this.deps.events.publish(room.roomId, { kind: "lease-released", terminalId });
  }
}

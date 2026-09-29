import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ParticipantSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class FocusParticipant {
  constructor(private readonly deps: { rooms: RoomRegistry; events: RoomEventPublisher }) {}

  async execute(
    requester: Connection,
    session: ParticipantSession,
    terminalId: number | null,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) return;

    const result = await this.deps.rooms.change(room, (draft) =>
      draft.focusParticipant(session.clientId, terminalId),
    );
    if (result === "rejected") {
      requester.send({
        type: "error",
        code: "bad-message",
        message: `존재하지 않는 터미널 focus: ${terminalId}`,
      });
      return;
    }
    if (result === "unchanged") return;

    this.deps.events.publish(room.roomId, {
      kind: "participant-focus-changed",
      clientId: session.clientId,
      focusedTerminalId: terminalId,
    });
  }
}

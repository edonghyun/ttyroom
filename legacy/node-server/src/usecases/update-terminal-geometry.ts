import type { TerminalGeometry } from "../domain/room.js";
import type { RoomRegistry } from "./room-registry.js";
import type { ParticipantSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class UpdateTerminalGeometry {
  constructor(private readonly deps: { rooms: RoomRegistry; events: RoomEventPublisher }) {}

  async execute(
    session: ParticipantSession,
    terminalId: number,
    geometry: TerminalGeometry,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room?.terminal(terminalId)) return;

    await this.deps.rooms.change(room, (draft) =>
      draft.updateTerminalGeometry(terminalId, geometry),
    );
    this.deps.events.publish(room.roomId, {
      kind: "terminal-geometry-changed",
      terminalId,
      geometry,
    });
  }
}

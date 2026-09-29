import type { RoomRegistry } from "./room-registry.js";
import type { ParticipantSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class RenameTerminal {
  constructor(private readonly deps: { rooms: RoomRegistry; events: RoomEventPublisher }) {}

  async execute(session: ParticipantSession, terminalId: number, title: string): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room?.terminal(terminalId)) return;
    const changed = await this.deps.rooms.change(room, (draft) =>
      draft.renameTerminal(terminalId, title),
    );
    if (!changed) return;

    this.deps.events.publish(room.roomId, { kind: "terminal-renamed", terminalId, title });
  }
}

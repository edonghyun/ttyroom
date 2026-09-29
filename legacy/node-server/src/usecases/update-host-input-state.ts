import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { HostSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class UpdateHostInputState {
  constructor(private readonly deps: { rooms: RoomRegistry; events: RoomEventPublisher }) {}

  async execute(
    connection: Connection,
    session: HostSession,
    remoteInputAllowed: boolean,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "등록된 host 세션이 아니다",
      });
      return;
    }
    const hostId = session.hostId;

    const changed = await this.deps.rooms.change(room, (draft) =>
      draft.setHostRemoteInputAllowed(hostId, remoteInputAllowed),
    );
    if (!changed) return;

    this.deps.events.publish(room.roomId, {
      kind: "host-input-state-changed",
      hostId,
      remoteInputAllowed,
    });
  }
}

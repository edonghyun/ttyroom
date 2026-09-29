import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, ParticipantSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class SetTerminalMode {
  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      events: RoomEventPublisher;
    },
  ) {}

  async execute(
    requester: Connection,
    session: ParticipantSession,
    terminalId: number,
    mode: "exclusive" | "shared",
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    if (!room || !terminal) {
      requester.send({
        type: "terminal-request-rejected",
        request: "set-mode",
        terminalId,
        reason: "terminal-not-found",
      });
      return;
    }
    if (terminal.status !== "open") {
      requester.send({
        type: "terminal-request-rejected",
        request: "set-mode",
        terminalId,
        reason: "terminal-not-open",
      });
      return;
    }
    if (!this.deps.connections.hostSession(room.roomId, terminal.hostId)) {
      requester.send({
        type: "terminal-request-rejected",
        request: "set-mode",
        terminalId,
        reason: "host-offline",
      });
      return;
    }
    const changed = await this.deps.rooms.change(room, (draft) =>
      draft.setTerminalMode(terminalId, mode),
    );
    if (!changed) return;

    this.deps.events.publish(room.roomId, { kind: "terminal-mode-changed", terminalId, mode });
  }
}

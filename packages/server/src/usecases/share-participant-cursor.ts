import type { ClientMessage } from "@ttyroom/protocol";

import type { ConnectionRegistry, Session } from "./connection-registry.js";

type CursorPosition = Extract<ClientMessage, { type: "move-cursor" }>["position"];

export class ShareParticipantCursor {
  constructor(private readonly connections: ConnectionRegistry) {}

  execute(session: Session, position: CursorPosition): void {
    for (const participant of this.connections.participantsOf(session.roomId)) {
      if (participant.connection.connectionId === session.connection.connectionId) continue;
      participant.connection.send({
        type: "participant-cursor",
        clientId: session.clientId,
        position,
      });
    }
  }
}

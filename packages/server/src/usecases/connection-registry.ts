import type { ServerMessage } from "@ttyroom/protocol";
import type { Connection } from "../ports/transport.js";

export interface Session {
  connection: Connection;
  roomId: string;
  clientId: string;
  role: "participant" | "host";
  hostId?: string;
}

export class ConnectionRegistry {
  private readonly byConnectionId = new Map<string, Session>();

  register(session: Session): void {
    this.byConnectionId.set(session.connection.connectionId, session);
  }

  bySessionOf(connectionId: string): Session | undefined {
    return this.byConnectionId.get(connectionId);
  }

  unregister(connectionId: string): Session | undefined {
    const session = this.byConnectionId.get(connectionId);
    this.byConnectionId.delete(connectionId);
    return session;
  }

  participantsOf(roomId: string): Session[] {
    return [...this.byConnectionId.values()].filter(
      (s) => s.roomId === roomId && s.role === "participant",
    );
  }

  broadcast(roomId: string, message: ServerMessage): void {
    for (const session of this.participantsOf(roomId)) {
      session.connection.send(message);
    }
  }
}

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

  // supersede 불변식(JoinRoom이 유지) 하에서 (roomId, clientId)당 세션은 최대 1개 — 단수 반환
  byClientId(roomId: string, clientId: string): Session | undefined {
    return [...this.byConnectionId.values()].find(
      (s) => s.roomId === roomId && s.clientId === clientId,
    );
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

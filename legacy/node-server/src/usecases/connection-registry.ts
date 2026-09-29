import type { ServerMessage } from "@ttyroom/protocol";
import type { Connection } from "../ports/transport.js";

interface BaseSession {
  connection: Connection;
  roomId: string;
  clientId: string;
}

export interface ParticipantSession extends BaseSession {
  role: "participant";
}

export interface HostSession extends BaseSession {
  role: "host";
  hostId: string;
}

export type Session = ParticipantSession | HostSession;

export class ConnectionRegistry {
  private readonly byConnectionId = new Map<string, Session>();

  register(session: Session): void {
    this.byConnectionId.set(session.connection.connectionId, session);
  }

  bySessionOf(connectionId: string): Session | undefined {
    return this.byConnectionId.get(connectionId);
  }

  // supersede 불변식 하에서 (roomId, role, clientId)당 세션은 최대 1개 —
  // host와 participant는 같은 clientId여도 서로의 연결을 대체하지 않는다.
  byClientId<Role extends Session["role"]>(
    roomId: string,
    clientId: string,
    role: Role,
  ): Extract<Session, { role: Role }> | undefined {
    return [...this.byConnectionId.values()].find(
      (session): session is Extract<Session, { role: Role }> =>
        session.roomId === roomId && session.clientId === clientId && session.role === role,
    );
  }

  unregister(connectionId: string): Session | undefined {
    const session = this.byConnectionId.get(connectionId);
    this.byConnectionId.delete(connectionId);
    return session;
  }

  participantsOf(roomId: string): ParticipantSession[] {
    return [...this.byConnectionId.values()].filter(
      (session): session is ParticipantSession =>
        session.roomId === roomId && session.role === "participant",
    );
  }

  hostSession(roomId: string, hostId: string): HostSession | undefined {
    return [...this.byConnectionId.values()].find(
      (session): session is HostSession =>
        session.roomId === roomId && session.role === "host" && session.hostId === hostId,
    );
  }

  broadcast(roomId: string, message: ServerMessage): void {
    for (const session of this.participantsOf(roomId)) {
      session.connection.send(message);
    }
  }
}

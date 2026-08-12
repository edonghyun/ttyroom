import { PROTOCOL_VERSION, type HelloMessage } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Identity } from "../ports/identity.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";

export class JoinRoom {
  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      identity: Identity;
    },
  ) {}

  execute(conn: Connection, hello: HelloMessage): void {
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      conn.send({
        type: "error",
        code: "unsupported-protocol-version",
        message: `server=${PROTOCOL_VERSION}`,
      });
      conn.close();
      return;
    }

    const room = this.deps.rooms.get(hello.roomId);
    const auth = this.deps.identity.authenticate(hello, room);
    if (auth.kind === "rejected") {
      conn.send({ type: "error", code: auth.code, message: auth.code });
      conn.close();
      return;
    }

    // auth 성공 시 room은 반드시 존재 — LinkAuth가 room-not-found를 걸렀다
    if (hello.role === "participant") {
      room!.addParticipant(auth.clientId, auth.displayName);
      // register 전에 broadcast — 입장자 본인은 welcome의 스냅샷으로 자신을 보므로
      // participant-joined가 본인에게 중복 전달되지 않는다 (테스트가 이 순서를 고정)
      this.deps.connections.broadcast(room!.roomId, {
        type: "room-event",
        event: {
          kind: "participant-joined",
          participant: { clientId: auth.clientId, name: auth.displayName },
        },
      });
      this.deps.connections.register({
        connection: conn,
        roomId: room!.roomId,
        clientId: auth.clientId,
        role: "participant",
      });
      conn.send({ type: "welcome", selfClientId: auth.clientId, snapshot: room!.snapshot() });
      return;
    }

    // host 역할은 Task 7에서 확장
  }
}

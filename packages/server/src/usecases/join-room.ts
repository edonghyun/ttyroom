import { PROTOCOL_VERSION, type HelloMessage } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Identity } from "../ports/identity.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { ConnectHost } from "./connect-host.js";
import type { PendingDisconnects } from "./handle-disconnect.js";
import type { SyncLateJoiner } from "./sync-late-joiner.js";

export class JoinRoom {
  private readonly connectHost: ConnectHost;

  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      identity: Identity;
      pending: PendingDisconnects;
      syncLateJoiner: SyncLateJoiner;
    },
  ) {
    this.connectHost = new ConnectHost({
      connections: this.deps.connections,
      pending: this.deps.pending,
    });
  }

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
      this.deps.pending.cancel(hello.roomId, "participant", auth.clientId);
      // 재접속은 대체(supersede) — 1 participant clientId = 1 세션 불변식. 이전 연결은 여기서 닫히며,
      // 그 close 통지는 새 세션을 건드리지 않아야 하고(connectionId 기준 unregister),
      // T2.9(handleDisconnect)에서 유예 타이머도 걸지 않아야 한다.
      const existing = this.deps.connections.byClientId(hello.roomId, auth.clientId, "participant");
      if (existing) {
        this.deps.connections.unregister(existing.connection.connectionId);
        existing.connection.close();
      }

      // 재접속이면 다른 참여자는 left를 본 적 없다 — joined 재브로드캐스트 생략 (조용한 복원)
      const rejoining = room!.hasParticipant(auth.clientId);

      room!.addParticipant(auth.clientId, auth.displayName);
      // register 전에 broadcast — 입장자 본인은 welcome의 스냅샷으로 자신을 보므로
      // participant-joined가 본인에게 중복 전달되지 않는다 (테스트가 이 순서를 고정)
      if (!rejoining) {
        this.deps.connections.broadcast(room!.roomId, {
          type: "room-event",
          event: {
            kind: "participant-joined",
            participant: {
              clientId: auth.clientId,
              name: auth.displayName,
              focusedTerminalId: null,
            },
          },
        });
      }
      this.deps.connections.register({
        connection: conn,
        roomId: room!.roomId,
        clientId: auth.clientId,
        role: "participant",
      });
      conn.send({ type: "welcome", selfClientId: auth.clientId, snapshot: room!.snapshot() });
      this.deps.syncLateJoiner.execute(conn, room!);
      return;
    }

    this.connectHost.execute({
      connection: conn,
      room: room!,
      hostId: auth.clientId,
      displayName: auth.displayName,
    });
  }
}

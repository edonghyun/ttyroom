import { parseClientMessage } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Clock } from "../ports/clock.js";
import type { Identity } from "../ports/identity.js";
import type { Policy } from "../ports/policy.js";
import type { SnapshotStore } from "../ports/snapshot-store.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { JoinRoom } from "./join-room.js";

// 어댑터가 아는 유일한 진입점 — 프레임을 유즈케이스로 라우팅한다
export class ServerCore {
  private readonly joinRoom: JoinRoom;

  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      identity: Identity;
      clock: Clock;
      snapshots: SnapshotStore;
    },
    private readonly options: { policy: Policy },
  ) {
    this.joinRoom = new JoinRoom({
      rooms: deps.rooms,
      connections: deps.connections,
      identity: deps.identity,
    });
  }

  handleMessage(conn: Connection, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (parsed.kind === "bad-message") {
      conn.send({ type: "error", code: "bad-message", message: parsed.reason });
      return;
    }

    if (parsed.message.type === "hello") {
      // 세션 재개는 새 연결이 원칙(Transport 계약) — 등록된 연결의 재hello는 거부하되
      // 연결은 닫지 않는다 (기존 세션은 유효)
      if (this.deps.connections.bySessionOf(conn.connectionId)) {
        conn.send({ type: "error", code: "bad-message", message: "이미 입장한 연결의 hello" });
        return;
      }
      this.joinRoom.execute(conn, parsed.message);
      return;
    }

    const session = this.deps.connections.bySessionOf(conn.connectionId);
    if (!session) {
      conn.send({ type: "error", code: "bad-message", message: "hello가 선행돼야 한다" });
      return;
    }

    // 등록된 연결의 후속 메시지 — type별 라우팅은 Task 8~10에서 채워진다
    conn.send({
      type: "error",
      code: "bad-message",
      message: `미지원 메시지: ${parsed.message.type}`,
    });
  }

  handleData(_conn: Connection, _bytes: Uint8Array): void {
    // 데이터 프레임 라우팅은 Task 9(routeTerminalInput)에서 구현
  }

  handleClose(conn: Connection): void {
    // 유예·복원은 Task 11 — 지금은 세션 등록 해제만
    this.deps.connections.unregister(conn.connectionId);
  }
}

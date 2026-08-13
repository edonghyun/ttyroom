import { decodeDataFrame, parseClientMessage } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Clock } from "../ports/clock.js";
import type { Identity } from "../ports/identity.js";
import type { Policy } from "../ports/policy.js";
import type { SnapshotStore } from "../ports/snapshot-store.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { AcquireLease } from "./acquire-lease.js";
import { BroadcastTerminalOutput } from "./broadcast-terminal-output.js";
import { FocusParticipant } from "./focus-participant.js";
import { HandleDisconnect, PendingDisconnects } from "./handle-disconnect.js";
import { JoinRoom } from "./join-room.js";
import { OpenTerminal } from "./open-terminal.js";
import { ReleaseLease } from "./release-lease.js";
import { RenameTerminal } from "./rename-terminal.js";
import { ResyncTerminalOutput } from "./resync-terminal-output.js";
import { ResizeTerminal } from "./resize-terminal.js";
import { RouteTerminalInput } from "./route-terminal-input.js";
import { SetTerminalMode } from "./set-terminal-mode.js";
import { SyncLateJoiner } from "./sync-late-joiner.js";
import { UpdateHostInputState } from "./update-host-input-state.js";
import { UpdateTerminalGeometry } from "./update-terminal-geometry.js";

// 어댑터가 아는 유일한 진입점 — 프레임을 유즈케이스로 라우팅한다
export class ServerCore {
  private readonly joinRoom: JoinRoom;
  private readonly openTerminal: OpenTerminal;
  private readonly acquireLease: AcquireLease;
  private readonly releaseLease: ReleaseLease;
  private readonly resizeTerminal: ResizeTerminal;
  private readonly routeTerminalInput: RouteTerminalInput;
  private readonly broadcastTerminalOutput: BroadcastTerminalOutput;
  private readonly handleDisconnect: HandleDisconnect;
  private readonly updateHostInputState: UpdateHostInputState;
  private readonly setTerminalMode: SetTerminalMode;
  private readonly resyncTerminalOutput: ResyncTerminalOutput;
  private readonly focusParticipant: FocusParticipant;
  private readonly updateTerminalGeometry: UpdateTerminalGeometry;
  private readonly renameTerminal: RenameTerminal;

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
    const pending = new PendingDisconnects(deps.clock);
    this.broadcastTerminalOutput = new BroadcastTerminalOutput(
      { rooms: deps.rooms, connections: deps.connections },
      { policy: options.policy },
    );
    this.joinRoom = new JoinRoom({
      rooms: deps.rooms,
      connections: deps.connections,
      identity: deps.identity,
      pending,
      syncLateJoiner: new SyncLateJoiner(this.broadcastTerminalOutput),
    });
    this.openTerminal = new OpenTerminal({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.acquireLease = new AcquireLease({ rooms: deps.rooms, connections: deps.connections });
    this.releaseLease = new ReleaseLease({ rooms: deps.rooms, connections: deps.connections });
    this.resizeTerminal = new ResizeTerminal({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.routeTerminalInput = new RouteTerminalInput({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.handleDisconnect = new HandleDisconnect(
      { rooms: deps.rooms, connections: deps.connections, pending },
      { policy: options.policy },
    );
    this.updateHostInputState = new UpdateHostInputState({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.setTerminalMode = new SetTerminalMode({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.resyncTerminalOutput = new ResyncTerminalOutput({
      rooms: deps.rooms,
      output: this.broadcastTerminalOutput,
    });
    this.focusParticipant = new FocusParticipant({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.updateTerminalGeometry = new UpdateTerminalGeometry({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.renameTerminal = new RenameTerminal({
      rooms: deps.rooms,
      connections: deps.connections,
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

    if (parsed.message.type === "open-terminal-request" && session.role === "participant") {
      this.openTerminal.request(conn, session, parsed.message.hostId);
      return;
    }

    if (parsed.message.type === "close-terminal-request" && session.role === "participant") {
      this.openTerminal.requestClose(conn, session, parsed.message.terminalId);
      return;
    }

    if (parsed.message.type === "set-terminal-mode" && session.role === "participant") {
      this.setTerminalMode.execute(conn, session, parsed.message.terminalId, parsed.message.mode);
      return;
    }

    if (parsed.message.type === "resync-output-request" && session.role === "participant") {
      this.resyncTerminalOutput.execute(conn, session, parsed.message.terminalId);
      return;
    }

    if (parsed.message.type === "focus-terminal" && session.role === "participant") {
      this.focusParticipant.execute(conn, session, parsed.message.terminalId);
      return;
    }

    if (parsed.message.type === "update-terminal-geometry" && session.role === "participant") {
      this.updateTerminalGeometry.execute(
        session,
        parsed.message.terminalId,
        parsed.message.geometry,
      );
      return;
    }

    if (parsed.message.type === "rename-terminal" && session.role === "participant") {
      this.renameTerminal.execute(session, parsed.message.terminalId, parsed.message.title);
      return;
    }

    if (parsed.message.type === "acquire-lease" && session.role === "participant") {
      this.acquireLease.execute(conn, session, parsed.message.terminalId);
      return;
    }

    if (parsed.message.type === "release-lease" && session.role === "participant") {
      this.releaseLease.execute(conn, session, parsed.message.terminalId, parsed.message.leaseId);
      return;
    }

    if (parsed.message.type === "resize-request" && session.role === "participant") {
      this.resizeTerminal.execute(
        conn,
        session,
        parsed.message.terminalId,
        parsed.message.cols,
        parsed.message.rows,
      );
      return;
    }

    if (parsed.message.type === "terminal-opened" && session.role === "host") {
      this.openTerminal.confirmOpened(conn, session, parsed.message.terminalId);
      return;
    }

    if (parsed.message.type === "terminal-closed" && session.role === "host") {
      this.openTerminal.close(conn, session, parsed.message.terminalId, parsed.message.exitCode);
      return;
    }

    if (parsed.message.type === "terminal-meta" && session.role === "host") {
      this.openTerminal.updateMeta(conn, session, parsed.message.terminalId, parsed.message.meta);
      return;
    }

    if (parsed.message.type === "host-input-state" && session.role === "host") {
      this.updateHostInputState.execute(conn, session, parsed.message.remoteInputAllowed);
      return;
    }

    // 등록된 연결의 후속 메시지 — 나머지 type별 라우팅은 Task 8~10에서 채워진다
    conn.send({
      type: "error",
      code: "bad-message",
      message: `미지원 메시지: ${parsed.message.type}`,
    });
  }

  handleData(conn: Connection, bytes: Uint8Array): void {
    const decoded = decodeDataFrame(bytes);
    if (decoded.kind === "malformed") {
      conn.send({ type: "error", code: "bad-message", message: decoded.reason });
      return;
    }

    const session = this.deps.connections.bySessionOf(conn.connectionId);
    if (session?.role === "host" && decoded.frame.kind === "output") {
      this.broadcastTerminalOutput.execute(conn, session, decoded.frame);
      return;
    }

    if (!session || session.role !== "participant" || decoded.frame.kind !== "input") {
      conn.send({ type: "error", code: "bad-message", message: "허용되지 않은 데이터 프레임" });
      return;
    }

    this.routeTerminalInput.execute(conn, session, decoded.frame);
  }

  handleClose(conn: Connection): void {
    this.handleDisconnect.execute(conn);
  }
}

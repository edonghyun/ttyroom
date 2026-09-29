import { parseClientMessage, type ClientMessage } from "@ttyroom/protocol";
import type { Identity } from "../ports/identity.js";
import type { Connection } from "../ports/transport.js";
import { AcquireLease } from "./acquire-lease.js";
import type { BroadcastTerminalOutput } from "./broadcast-terminal-output.js";
import type { ConnectionRegistry, HostSession, ParticipantSession } from "./connection-registry.js";
import { FocusParticipant } from "./focus-participant.js";
import type { PendingDisconnects } from "./handle-disconnect.js";
import { JoinRoom } from "./join-room.js";
import { OpenTerminal } from "./open-terminal.js";
import type { ControlCommandOutcome, OperationalDiagnostics } from "./operational-diagnostics.js";
import { ReconcileHost } from "./reconcile-host.js";
import { ReleaseLease } from "./release-lease.js";
import { RenameTerminal } from "./rename-terminal.js";
import { ResyncTerminalOutput } from "./resync-terminal-output.js";
import { ResizeTerminal } from "./resize-terminal.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";
import type { RoomRegistry } from "./room-registry.js";
import { SetTerminalMode } from "./set-terminal-mode.js";
import { ShareParticipantCursor } from "./share-participant-cursor.js";
import { SyncLateJoiner } from "./sync-late-joiner.js";
import { UpdateHostInputState } from "./update-host-input-state.js";
import { UpdateTerminalGeometry } from "./update-terminal-geometry.js";

type FollowupMessage = Exclude<ClientMessage, { type: "hello" }>;

// Control Plane의 공개 표면은 raw message 하나다. Parse, session guard, role authorization,
// message routing과 use-case topology는 이 경계 안에 숨긴다.
export class ControlPlane {
  private readonly joinRoom: JoinRoom;
  private readonly openTerminal: OpenTerminal;
  private readonly acquireLease: AcquireLease;
  private readonly releaseLease: ReleaseLease;
  private readonly resizeTerminal: ResizeTerminal;
  private readonly updateHostInputState: UpdateHostInputState;
  private readonly setTerminalMode: SetTerminalMode;
  private readonly resyncTerminalOutput: ResyncTerminalOutput;
  private readonly focusParticipant: FocusParticipant;
  private readonly updateTerminalGeometry: UpdateTerminalGeometry;
  private readonly renameTerminal: RenameTerminal;
  private readonly reconcileHost: ReconcileHost;
  private readonly shareParticipantCursor: ShareParticipantCursor;

  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      identity: Identity;
      pendingDisconnects: PendingDisconnects;
      output: BroadcastTerminalOutput;
      events: RoomEventPublisher;
      diagnostics: OperationalDiagnostics;
    },
  ) {
    this.joinRoom = new JoinRoom({
      rooms: deps.rooms,
      connections: deps.connections,
      identity: deps.identity,
      events: deps.events,
      pending: deps.pendingDisconnects,
      syncLateJoiner: new SyncLateJoiner(deps.output),
    });
    this.openTerminal = new OpenTerminal({
      rooms: deps.rooms,
      connections: deps.connections,
      events: deps.events,
    });
    this.acquireLease = new AcquireLease({ rooms: deps.rooms, events: deps.events });
    this.releaseLease = new ReleaseLease({ rooms: deps.rooms, events: deps.events });
    this.resizeTerminal = new ResizeTerminal({
      rooms: deps.rooms,
      connections: deps.connections,
    });
    this.updateHostInputState = new UpdateHostInputState({
      rooms: deps.rooms,
      events: deps.events,
    });
    this.setTerminalMode = new SetTerminalMode({
      rooms: deps.rooms,
      connections: deps.connections,
      events: deps.events,
    });
    this.resyncTerminalOutput = new ResyncTerminalOutput({
      rooms: deps.rooms,
      output: deps.output,
    });
    this.focusParticipant = new FocusParticipant({
      rooms: deps.rooms,
      events: deps.events,
    });
    this.updateTerminalGeometry = new UpdateTerminalGeometry({
      rooms: deps.rooms,
      events: deps.events,
    });
    this.renameTerminal = new RenameTerminal({
      rooms: deps.rooms,
      events: deps.events,
    });
    this.reconcileHost = new ReconcileHost({
      rooms: deps.rooms,
      events: deps.events,
      output: deps.output,
    });
    this.shareParticipantCursor = new ShareParticipantCursor(deps.connections);
  }

  async handle(connection: Connection, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    const session = this.deps.connections.bySessionOf(connection.connectionId);
    const commandType = parsed.kind === "bad-message" ? "unparseable" : parsed.message.type;
    const roomId =
      parsed.kind === "ok" && parsed.message.type === "hello"
        ? parsed.message.roomId
        : session?.roomId;
    const role =
      parsed.kind === "ok" && parsed.message.type === "hello" && "role" in parsed.message
        ? parsed.message.role
        : session?.role;

    await this.deps.diagnostics.controlCommand(
      {
        commandType,
        connectionId: connection.connectionId,
        roomId,
        role,
      },
      async () => {
        if (parsed.kind === "bad-message") {
          connection.send({ type: "error", code: "bad-message", message: parsed.reason });
          return rejected("bad-message");
        }

        if (parsed.message.type === "hello") {
          return this.handleHello(connection, parsed.message);
        }

        if (!session) {
          connection.send({
            type: "error",
            code: "bad-message",
            message: "hello가 선행돼야 한다",
          });
          return rejected("hello-required");
        }

        if (session.role === "participant") {
          return this.handleParticipant(connection, session, parsed.message);
        }
        return this.handleHost(connection, session, parsed.message);
      },
    );
  }

  private async handleHello(
    connection: Connection,
    hello: Extract<ClientMessage, { type: "hello" }>,
  ): Promise<ControlCommandOutcome> {
    // 세션 재개는 새 연결이 원칙(Transport 계약) — 등록된 연결의 재hello는 거부하되
    // 연결은 닫지 않는다 (기존 세션은 유효).
    if (this.deps.connections.bySessionOf(connection.connectionId)) {
      connection.send({ type: "error", code: "bad-message", message: "이미 입장한 연결의 hello" });
      return rejected("already-joined");
    }
    await this.joinRoom.execute(connection, hello);
    return completed();
  }

  private async handleParticipant(
    connection: Connection,
    session: ParticipantSession,
    message: FollowupMessage,
  ): Promise<ControlCommandOutcome> {
    switch (message.type) {
      case "open-terminal-request":
        await this.openTerminal.request(connection, session, message.hostId);
        return completed();
      case "close-terminal-request":
        this.openTerminal.requestClose(connection, session, message.terminalId);
        return completed();
      case "set-terminal-mode":
        await this.setTerminalMode.execute(connection, session, message.terminalId, message.mode);
        return completed();
      case "resync-output-request":
        this.resyncTerminalOutput.execute(connection, session, message.terminalId);
        return completed();
      case "focus-terminal":
        await this.focusParticipant.execute(connection, session, message.terminalId);
        return completed();
      case "move-cursor":
        this.shareParticipantCursor.execute(session, message.position);
        return completed();
      case "update-terminal-geometry":
        await this.updateTerminalGeometry.execute(session, message.terminalId, message.geometry);
        return completed();
      case "rename-terminal":
        await this.renameTerminal.execute(session, message.terminalId, message.title);
        return completed();
      case "acquire-lease":
        await this.acquireLease.execute(connection, session, message.terminalId);
        return completed();
      case "release-lease":
        await this.releaseLease.execute(connection, session, message.terminalId, message.leaseId);
        return completed();
      case "resize-request":
        this.resizeTerminal.execute(
          connection,
          session,
          message.terminalId,
          message.cols,
          message.rows,
        );
        return completed();
      case "terminal-opened":
      case "terminal-closed":
      case "terminal-meta":
      case "host-input-state":
      case "host-inventory":
      case "terminal-replay-complete":
        return rejectUnsupported(connection, message);
    }
    assertNever(message);
  }

  private async handleHost(
    connection: Connection,
    session: HostSession,
    message: FollowupMessage,
  ): Promise<ControlCommandOutcome> {
    switch (message.type) {
      case "terminal-opened":
        await this.openTerminal.confirmOpened(
          connection,
          session,
          message.terminalId,
          message.runtimeId,
        );
        return completed();
      case "host-inventory":
        await this.reconcileHost.inventory(connection, session, message);
        return completed();
      case "terminal-replay-complete":
        this.reconcileHost.replayComplete(
          connection,
          session,
          message.terminalId,
          message.lastOutputSeq,
        );
        return completed();
      case "terminal-closed":
        await this.openTerminal.close(connection, session, message.terminalId, message.exitCode);
        return completed();
      case "terminal-meta":
        await this.openTerminal.updateMeta(connection, session, message.terminalId, message.meta);
        return completed();
      case "host-input-state":
        await this.updateHostInputState.execute(connection, session, message.remoteInputAllowed);
        return completed();
      case "open-terminal-request":
      case "close-terminal-request":
      case "set-terminal-mode":
      case "resync-output-request":
      case "focus-terminal":
      case "move-cursor":
      case "update-terminal-geometry":
      case "rename-terminal":
      case "acquire-lease":
      case "release-lease":
      case "resize-request":
        return rejectUnsupported(connection, message);
    }
    assertNever(message);
  }
}

function rejectUnsupported(
  connection: Connection,
  message: FollowupMessage,
): ControlCommandOutcome {
  connection.send({
    type: "error",
    code: "bad-message",
    message: `미지원 메시지: ${message.type}`,
  });
  return rejected("unsupported-for-role");
}

function completed(): ControlCommandOutcome {
  return { outcome: "completed" };
}

function rejected(reason: string): ControlCommandOutcome {
  return { outcome: "rejected", reason };
}

function assertNever(value: never): never {
  throw new Error(`처리되지 않은 control message: ${JSON.stringify(value)}`);
}

import { TerminalIdsExhausted, type Room, type TerminalMetadata } from "../domain/room.js";
import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, HostSession, ParticipantSession } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

export class OpenTerminal {
  private readonly confirmedByRoom = new WeakMap<Room, Set<number>>();

  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      events: RoomEventPublisher;
    },
  ) {}

  async request(requester: Connection, session: ParticipantSession, hostId: string): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    const host = this.deps.connections.hostSession(session.roomId, hostId);
    if (!room || !host) {
      requester.send({ type: "error", code: "bad-message", message: "host가 오프라인이다" });
      return;
    }

    let terminal: ReturnType<Room["openTerminal"]>;
    try {
      terminal = await this.deps.rooms.change(room, (draft) => draft.openTerminal(hostId));
    } catch (error) {
      if (!(error instanceof TerminalIdsExhausted)) throw error;
      requester.send({
        type: "error",
        code: "bad-message",
        message: "terminal ID space exhausted",
      });
      return;
    }
    // Connector에 부작용을 요청하기 전에 terminalId를 내구화한다. commit 뒤 전송 전에
    // 서버가 죽으면 다음 inventory reconciliation이 pending 터미널을 정리한다.
    host.connection.send({
      type: "open-terminal",
      terminalId: terminal.terminalId,
      cols: 80,
      rows: 24,
    });
  }

  requestClose(requester: Connection, session: ParticipantSession, terminalId: number): void {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    if (!terminal) {
      requester.send({
        type: "terminal-request-rejected",
        request: "close",
        terminalId,
        reason: "terminal-not-found",
      });
      return;
    }
    if (terminal.status !== "open") {
      requester.send({
        type: "terminal-request-rejected",
        request: "close",
        terminalId,
        reason: "terminal-not-open",
      });
      return;
    }
    const host = this.deps.connections.hostSession(session.roomId, terminal.hostId);
    if (!host) {
      requester.send({
        type: "terminal-request-rejected",
        request: "close",
        terminalId,
        reason: "host-offline",
      });
      return;
    }

    host.connection.send({ type: "close-terminal", terminalId });
  }

  async confirmOpened(
    connection: Connection,
    session: HostSession,
    terminalId: number,
    runtimeId: string,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    if (!room || !terminal || terminal.hostId !== session.hostId) {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "host가 소유하지 않은 터미널이다",
      });
      return;
    }
    if (terminal.status !== "open") return;
    await this.deps.rooms.change(room, (draft) =>
      draft.confirmTerminalOpened(terminalId, runtimeId),
    );

    const confirmed = this.confirmedByRoom.get(room) ?? new Set<number>();
    if (confirmed.has(terminalId)) return;
    confirmed.add(terminalId);
    this.confirmedByRoom.set(room, confirmed);

    this.deps.events.publish(room.roomId, { kind: "terminal-opened", terminal });
  }

  async close(
    connection: Connection,
    session: HostSession,
    terminalId: number,
    exitCode: number | null,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    if (!room || !terminal || terminal.hostId !== session.hostId) {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "host가 소유하지 않은 터미널이다",
      });
      return;
    }

    if (terminal.status === "exited") return;

    await this.deps.rooms.change(room, (draft) => draft.markTerminalExited(terminalId, exitCode));
    this.deps.events.publish(room.roomId, { kind: "terminal-closed", terminalId, exitCode });
  }

  async updateMeta(
    connection: Connection,
    session: HostSession,
    terminalId: number,
    meta: TerminalMetadata,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    if (!room || !terminal || terminal.hostId !== session.hostId) {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "host가 소유하지 않은 터미널이다",
      });
      return;
    }

    if (
      terminal.meta.cwd === meta.cwd &&
      terminal.meta.gitBranch === meta.gitBranch &&
      terminal.meta.fgProcess === meta.fgProcess
    ) {
      return;
    }

    await this.deps.rooms.change(room, (draft) => draft.updateTerminalMeta(terminalId, meta));
    this.deps.events.publish(room.roomId, { kind: "terminal-meta", terminalId, meta });
  }
}

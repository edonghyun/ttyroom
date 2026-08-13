import type { ClientMessage } from "@ttyroom/protocol";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { BroadcastTerminalOutput } from "./broadcast-terminal-output.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";

type HostInventory = Extract<ClientMessage, { type: "host-inventory" }>;

export class ReconcileHost {
  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      output: BroadcastTerminalOutput;
    },
  ) {}

  async inventory(
    connection: Connection,
    session: Session,
    inventory: HostInventory,
  ): Promise<void> {
    const room = this.deps.rooms.get(session.roomId);
    const hostId = session.hostId;
    if (!room || !hostId) {
      connection.send({ type: "error", code: "bad-message", message: "등록된 host가 아니다" });
      return;
    }

    const result = await this.deps.rooms.change(room, (draft) =>
      draft.reconcileHostTerminals(hostId, inventory.terminals),
    );
    const host = room.snapshot().hosts.find((candidate) => candidate.hostId === hostId);
    if (!host) throw new Error(`reconciliation을 마친 host가 없다: ${hostId}`);

    for (const terminalId of result.agentTerminalIdsToClose) {
      connection.send({ type: "close-terminal", terminalId });
    }
    connection.send({
      type: "host-ready",
      terminals: result.activeTerminalIds.map((terminalId) => ({
        terminalId,
        replayAfterSeq: this.deps.output.lastSourceSeqFor(room, terminalId),
      })),
    });
    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "host-connected", host },
    });
    for (const terminalId of result.closedTerminalIds) {
      this.deps.connections.broadcast(room.roomId, {
        type: "room-event",
        event: { kind: "terminal-closed", terminalId, exitCode: null },
      });
    }
    for (const terminal of result.recoveredTerminals) {
      this.deps.connections.broadcast(room.roomId, {
        type: "room-event",
        event: { kind: "terminal-opened", terminal },
      });
    }
  }

  replayComplete(
    connection: Connection,
    session: Session,
    terminalId: number,
    lastOutputSeq: number,
  ): void {
    const room = this.deps.rooms.get(session.roomId);
    const terminal = room?.terminal(terminalId);
    if (!room || !terminal || terminal.hostId !== session.hostId || terminal.status !== "open") {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "복구 완료를 보고할 수 없는 터미널이다",
      });
      return;
    }
    this.deps.output.acknowledgeSourceSeq(room, terminalId, lastOutputSeq);
    this.deps.output.syncParticipants(room, terminalId);
  }
}

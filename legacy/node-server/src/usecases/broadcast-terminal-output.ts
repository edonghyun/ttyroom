import type { OutputFrame } from "@ttyroom/protocol";
import type { Room } from "../domain/room.js";
import type { RoomRegistry } from "./room-registry.js";
import type { Policy } from "../ports/policy.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, HostSession } from "./connection-registry.js";
import { ScrollbackBuffer } from "./scrollback-buffer.js";
import type { OperationalDiagnostics } from "./operational-diagnostics.js";

export class BroadcastTerminalOutput {
  private readonly outputByRoom = new WeakMap<Room, Map<number, TerminalOutput>>();
  private readonly gaps = new WeakMap<
    Connection,
    Map<number, { fromSeq: number; toSeq: number; droppedFrames: number }>
  >();

  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      diagnostics: OperationalDiagnostics;
    },
    private readonly options: { policy: Policy },
  ) {}

  execute(connection: Connection, session: HostSession, incoming: OutputFrame): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room) throw new Error(`등록된 세션의 Room이 없다: ${session.roomId}`);

    const terminal = room.terminal(incoming.terminalId);
    if (!terminal || terminal.status !== "open" || terminal.hostId !== session.hostId) {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "host가 소유한 열린 터미널이 아니다",
      });
      return;
    }

    const output = this.outputFor(room, incoming.terminalId);
    // Connector source seq는 reconnect replay 중복 제거용이고, 브라우저 seq는 서버 수명 안에서
    // 연속적으로 다시 부여한다. 서버 재시작 뒤 welcome이 브라우저 projection을 reset하므로
    // retained Connector frame이 source seq 중간부터 시작해도 1부터 끊김 없이 복구된다.
    if (incoming.seq <= output.lastSourceSeq) return;
    output.lastSourceSeq = incoming.seq;
    const seq = output.lastSeq + 1;
    output.lastSeq = seq;
    const frame: OutputFrame = { ...incoming, seq };
    output.buffer.append(frame);
    for (const participant of this.deps.connections.participantsOf(room.roomId)) {
      const bufferedBytes = participant.connection.bufferedBytes();
      if (bufferedBytes >= this.options.policy.sendBufferDropThresholdBytes) {
        const connectionGaps = this.gaps.get(participant.connection) ?? new Map();
        const gap = connectionGaps.get(frame.terminalId);
        if (!gap) {
          this.deps.diagnostics.replayGap({
            phase: "opened",
            connectionId: participant.connection.connectionId,
            roomId: room.roomId,
            terminalId: frame.terminalId,
            fromSeq: frame.seq,
            toSeq: frame.seq,
            droppedFrames: 1,
            bufferedBytes,
          });
        }
        connectionGaps.set(frame.terminalId, {
          fromSeq: gap?.fromSeq ?? frame.seq,
          toSeq: frame.seq,
          droppedFrames: (gap?.droppedFrames ?? 0) + 1,
        });
        this.gaps.set(participant.connection, connectionGaps);
        continue;
      }
      const connectionGaps = this.gaps.get(participant.connection);
      const gap = connectionGaps?.get(frame.terminalId);
      if (gap) {
        this.deps.diagnostics.replayGap({
          phase: "recovered",
          connectionId: participant.connection.connectionId,
          roomId: room.roomId,
          terminalId: frame.terminalId,
          fromSeq: gap.fromSeq,
          toSeq: gap.toSeq,
          droppedFrames: gap.droppedFrames,
          bufferedBytes: participant.connection.bufferedBytes(),
        });
        participant.connection.send({
          type: "sync",
          terminalId: frame.terminalId,
          seq: gap.toSeq,
        });
        participant.connection.send({
          type: "output-gap",
          terminalId: frame.terminalId,
          fromSeq: gap.fromSeq,
          toSeq: gap.toSeq,
        });
        connectionGaps?.delete(frame.terminalId);
        if (connectionGaps?.size === 0) this.gaps.delete(participant.connection);
      }
      participant.connection.sendData(frame);
    }
  }

  framesFor(room: Room, terminalId: number): OutputFrame[] {
    return this.outputByRoom.get(room)?.get(terminalId)?.buffer.frames() ?? [];
  }

  lastSeqFor(room: Room, terminalId: number): number {
    return this.outputByRoom.get(room)?.get(terminalId)?.lastSeq ?? 0;
  }

  lastSourceSeqFor(room: Room, terminalId: number): number {
    return this.outputByRoom.get(room)?.get(terminalId)?.lastSourceSeq ?? 0;
  }

  acknowledgeSourceSeq(room: Room, terminalId: number, sourceSeq: number): void {
    const output = this.outputFor(room, terminalId);
    output.lastSourceSeq = Math.max(output.lastSourceSeq, sourceSeq);
  }

  syncParticipants(room: Room, terminalId: number): void {
    const seq = this.lastSeqFor(room, terminalId);
    for (const participant of this.deps.connections.participantsOf(room.roomId)) {
      participant.connection.send({ type: "sync", terminalId, seq });
    }
  }

  private outputFor(room: Room, terminalId: number): TerminalOutput {
    let roomOutput = this.outputByRoom.get(room);
    if (!roomOutput) {
      roomOutput = new Map();
      this.outputByRoom.set(room, roomOutput);
    }
    let output = roomOutput.get(terminalId);
    if (!output) {
      output = {
        buffer: new ScrollbackBuffer({
          maxBytes: this.options.policy.scrollbackBytesPerTerminal,
        }),
        lastSeq: 0,
        lastSourceSeq: 0,
      };
      roomOutput.set(terminalId, output);
    }
    return output;
  }
}

interface TerminalOutput {
  buffer: ScrollbackBuffer;
  lastSeq: number;
  lastSourceSeq: number;
}

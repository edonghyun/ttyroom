import type { OutputFrame } from "@ttyroom/protocol";
import type { Room } from "../domain/room.js";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Policy } from "../ports/policy.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, Session } from "./connection-registry.js";
import { ScrollbackBuffer } from "./scrollback-buffer.js";

export class BroadcastTerminalOutput {
  private readonly outputByRoom = new WeakMap<Room, Map<number, TerminalOutput>>();
  private readonly gaps = new WeakMap<
    Connection,
    Map<number, { fromSeq: number; toSeq: number }>
  >();

  constructor(
    private readonly deps: { rooms: RoomRegistry; connections: ConnectionRegistry },
    private readonly options: { policy: Policy },
  ) {}

  execute(connection: Connection, session: Session, incoming: OutputFrame): void {
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
    const seq = output.lastSeq + 1;
    output.lastSeq = seq;
    const frame: OutputFrame = { ...incoming, seq };
    output.buffer.append(frame);
    for (const participant of this.deps.connections.participantsOf(room.roomId)) {
      if (
        participant.connection.bufferedBytes() >= this.options.policy.sendBufferDropThresholdBytes
      ) {
        const connectionGaps = this.gaps.get(participant.connection) ?? new Map();
        const gap = connectionGaps.get(frame.terminalId);
        connectionGaps.set(frame.terminalId, {
          fromSeq: gap?.fromSeq ?? frame.seq,
          toSeq: frame.seq,
        });
        this.gaps.set(participant.connection, connectionGaps);
        continue;
      }
      const connectionGaps = this.gaps.get(participant.connection);
      const gap = connectionGaps?.get(frame.terminalId);
      if (gap) {
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
      };
      roomOutput.set(terminalId, output);
    }
    return output;
  }
}

interface TerminalOutput {
  buffer: ScrollbackBuffer;
  lastSeq: number;
}

import type { Room } from "../domain/room.js";
import type { Connection } from "../ports/transport.js";
import type { BroadcastTerminalOutput } from "./broadcast-terminal-output.js";

export class SyncLateJoiner {
  constructor(private readonly output: BroadcastTerminalOutput) {}

  execute(connection: Connection, room: Room): void {
    for (const terminal of room.snapshot().terminals) {
      if (terminal.status !== "open") continue;
      for (const frame of this.output.framesFor(terminal.terminalId)) {
        connection.sendData(frame);
      }
      connection.send({
        type: "sync",
        terminalId: terminal.terminalId,
        seq: this.output.lastSeqFor(terminal.terminalId),
      });
    }
  }
}

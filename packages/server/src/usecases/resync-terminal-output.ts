import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { BroadcastTerminalOutput } from "./broadcast-terminal-output.js";
import type { Session } from "./connection-registry.js";

export class ResyncTerminalOutput {
  constructor(private readonly deps: { rooms: RoomRegistry; output: BroadcastTerminalOutput }) {}

  execute(requester: Connection, session: Session, terminalId: number): void {
    const room = this.deps.rooms.get(session.roomId);
    if (!room?.terminal(terminalId)) {
      requester.send({
        type: "terminal-request-rejected",
        request: "resync-output",
        terminalId,
        reason: "terminal-not-found",
      });
      return;
    }

    for (const frame of this.deps.output.framesFor(room, terminalId)) {
      requester.sendData(frame);
    }
    requester.send({
      type: "sync",
      terminalId,
      seq: this.deps.output.lastSeqFor(room, terminalId),
    });
  }
}

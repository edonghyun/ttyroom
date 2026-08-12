import type { DataFrame, ServerMessage } from "@ttyroom/protocol";
import type { Connection } from "../ports/transport.js";

export class RecordingConnection implements Connection {
  readonly connectionId: string;
  readonly messages: ServerMessage[] = [];
  readonly dataFrames: DataFrame[] = [];
  readonly arrivalOrder: Array<
    { kind: "message"; message: ServerMessage } | { kind: "data"; frame: DataFrame }
  > = [];
  // 테스트가 백프레셔를 시뮬레이션할 때 직접 설정한다
  bufferedBytesValue = 0;
  closed = false;

  private readonly guard: ((what: "message" | "data") => void) | undefined;

  constructor(options: { connectionId: string; guard?: (what: "message" | "data") => void }) {
    this.connectionId = options.connectionId;
    this.guard = options.guard;
  }

  send(message: ServerMessage): void {
    this.guard?.("message");
    this.messages.push(message);
    this.arrivalOrder.push({ kind: "message", message });
  }

  sendData(frame: DataFrame): void {
    this.guard?.("data");
    this.dataFrames.push(frame);
    this.arrivalOrder.push({ kind: "data", frame });
  }

  bufferedBytes(): number {
    return this.bufferedBytesValue;
  }

  close(): void {
    this.closed = true;
  }
}

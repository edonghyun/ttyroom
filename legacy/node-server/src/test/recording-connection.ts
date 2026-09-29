import type { DataFrame, RoomEvent, ServerMessage } from "@ttyroom/protocol";
import type { Connection } from "../ports/transport.js";

export class RecordingConnection implements Connection {
  readonly connectionId: string;
  readonly messages: ServerMessage[] = [];
  readonly dataFrames: DataFrame[] = [];
  readonly arrivalOrder: Array<
    { kind: "message"; message: ServerMessage } | { kind: "data"; frame: DataFrame }
  > = [];
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

  messagesOfType<T extends ServerMessage["type"]>(
    type: T,
  ): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    );
  }

  lastMessageOfType<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> {
    const message = this.messagesOfType(type).at(-1);
    if (!message) {
      throw new Error(
        `type "${type}" 메시지가 없다 — received types: ${
          this.messages.map((candidate) => candidate.type).join(", ") || "(없음)"
        }`,
      );
    }
    return message;
  }

  roomEventsOfKind<K extends RoomEvent["kind"]>(kind: K): Array<Extract<RoomEvent, { kind: K }>> {
    return this.messagesOfType("room-event")
      .map((message) => message.event)
      .filter((event): event is Extract<RoomEvent, { kind: K }> => event.kind === kind);
  }

  clear(): void {
    this.messages.length = 0;
    this.dataFrames.length = 0;
    this.arrivalOrder.length = 0;
  }
}

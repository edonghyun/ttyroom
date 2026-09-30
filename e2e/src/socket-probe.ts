import WebSocket from "ws";
import {
  parseServerMessage,
  decodeDataFrame,
  type DataFrame,
  type ServerMessage,
} from "@ttyroom/protocol";
import { waitUntil } from "./wait-until.js";

export type ProbePacket =
  { kind: "control"; message: ServerMessage } | { kind: "binary"; frame: DataFrame };

/** Raw protocol peer: preserves control/binary arrival order without projection or deduplication. */
export class SocketProbe {
  private readonly messages: ProbePacket[] = [];
  private closeCode: number | undefined;
  private failure: Error | undefined;
  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw, binary) => {
      if (binary) {
        const bytes =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : Buffer.concat(Array.isArray(raw) ? raw : [raw]);
        const decoded = decodeDataFrame(bytes);
        if (decoded.kind === "ok") this.messages.push({ kind: "binary", frame: decoded.frame });
        else this.failure = new Error("Invalid server binary frame");
        return;
      }
      const parsed = parseServerMessage(raw.toString());
      if (parsed.kind === "ok") this.messages.push({ kind: "control", message: parsed.message });
      else this.failure = new Error("Invalid server protocol message");
    });
    socket.on("close", (code) => {
      this.closeCode = code;
    });
    socket.on("error", (error) => {
      this.failure = error;
    });
  }
  static async connect(baseUrl: string) {
    const probe = new SocketProbe(
      new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, {
        handshakeTimeout: 5_000,
        origin: "http://other-origin.test",
      }),
    );
    try {
      await waitUntil(() => {
        probe.check();
        return probe.socket.readyState === WebSocket.OPEN;
      });
      return probe;
    } catch (error) {
      probe.socket.terminate();
      throw error;
    }
  }
  send(message: unknown) {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }
  sendBytes(bytes: Uint8Array) {
    this.socket.send(bytes);
  }
  startTextMessage(part: string) {
    this.socket.send(part, { binary: false, fin: false });
  }
  startBinaryMessage(part: Uint8Array) {
    this.socket.send(part, { binary: true, fin: false });
  }
  async closureCode(): Promise<number> {
    await waitUntil(() => this.closeCode !== undefined);
    return this.closeCode!;
  }
  sendTextParts(...parts: string[]) {
    parts.forEach((part, index) =>
      this.socket.send(part, { binary: false, fin: index === parts.length - 1 }),
    );
  }
  sendByteParts(...parts: Uint8Array[]) {
    parts.forEach((part, index) =>
      this.socket.send(part, { binary: true, fin: index === parts.length - 1 }),
    );
  }
  async next(): Promise<ServerMessage> {
    const packet = await this.nextPacket();
    if (packet.kind !== "control")
      throw new Error("Expected a control message, received binary data");
    return packet.message;
  }
  async nextPacket(): Promise<ProbePacket> {
    await waitUntil(() => {
      this.check();
      if (this.messages.length > 0) return true;
      if (this.socket.readyState === WebSocket.CLOSED)
        throw new Error("Socket closed before expected message");
      return false;
    });
    return this.messages.shift()!;
  }
  async disconnect() {
    this.socket.close();
    await this.closed();
  }
  async closed() {
    await waitUntil(() => this.socket.readyState === WebSocket.CLOSED);
  }
  private check() {
    if (this.failure) throw this.failure;
  }
  async [Symbol.asyncDispose]() {
    this.socket.terminate();
    await this.closed();
  }
}

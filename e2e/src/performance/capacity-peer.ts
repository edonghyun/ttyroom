import WebSocket from "ws";
import {
  decodeDataFrame,
  encodeDataFrame,
  parseServerMessage,
  type ServerMessage,
} from "@ttyroom/protocol";
import { waitUntil } from "../wait-until.js";
import { Latencies } from "./capacity-report.js";

/** Synthetic wire endpoint: counts payloads without retaining terminal output or unbounded messages. */
export class CapacityPeer {
  output = new Latencies();
  control = new Latencies();
  readonly syncs = new Set<number>();
  readonly lastSequences = new Map<number, number>();
  readonly pendingControls = new Map<number, number>();
  readonly notices = new Map<string, { count: number; message: ServerMessage }>();
  receivedFrames = 0;
  receivedBytes = 0;
  gaps = 0;
  sequenceErrors = 0;
  closed: number | undefined;
  error: string | undefined;
  mode: "idle" | "live" | "replay" = "idle";
  private constructor(readonly socket: WebSocket) {
    socket.on("error", (error) => {
      this.error = error.message;
    });
    socket.on("close", (code) => {
      this.closed = code;
    });
    socket.on("message", (data, binary) => {
      const bytes =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(Array.isArray(data) ? data : [data]);
      if (binary) {
        const decoded = decodeDataFrame(bytes);
        if (decoded.kind !== "ok" || decoded.frame.kind !== "output") {
          this.error = "Invalid output frame";
          return;
        }
        if (this.mode === "idle") return;
        const frame = decoded.frame;
        this.receivedFrames++;
        this.receivedBytes += frame.payload.length;
        if (this.mode === "live") {
          const payload = Buffer.from(
            frame.payload.buffer,
            frame.payload.byteOffset,
            frame.payload.byteLength,
          );
          if (payload.length !== 4096) {
            this.error = "Unexpected payload size";
            return;
          }
          const expected = (this.lastSequences.get(frame.terminalId) ?? 0) + 1;
          if (frame.seq !== expected || payload.readUInt32BE(8) !== expected) this.sequenceErrors++;
          this.lastSequences.set(frame.terminalId, frame.seq);
          const latency = performance.now() - payload.readDoubleBE(0);
          if (!Number.isFinite(latency) || latency < 0) {
            this.error = "Invalid output timestamp";
            return;
          }
          this.output.add(latency);
        }
        return;
      }
      const parsed = parseServerMessage(bytes.toString());
      if (parsed.kind !== "ok") {
        this.error = "Invalid server control";
        return;
      }
      const message = parsed.message;
      this.notices.set(message.type, {
        count: (this.notices.get(message.type)?.count ?? 0) + 1,
        message,
      });
      if (message.type === "sync") this.syncs.add(message.terminalId);
      if (message.type === "output-gap") this.gaps++;
      if (message.type === "error") this.error = `Server error: ${message.code}`;
      if (message.type === "lease-invalid") {
        const started = this.pendingControls.get(message.terminalId);
        if (started !== undefined) {
          this.control.add(performance.now() - started);
          this.pendingControls.delete(message.terminalId);
        }
      }
    });
  }
  static async connect(baseUrl: string, hello: object, mode: "idle" | "replay" = "idle") {
    const peer = new CapacityPeer(
      new WebSocket(baseUrl.replace("http:", "ws:") + "/ws", { handshakeTimeout: 5000 }),
    );
    peer.mode = mode;
    try {
      await peer.wait(() => peer.socket.readyState === WebSocket.OPEN);
      await peer.notice("welcome", () => peer.send(hello));
      return peer;
    } catch (error) {
      peer.close();
      throw error;
    }
  }
  resetObservations() {
    this.output = new Latencies();
    this.control = new Latencies();
    this.receivedFrames = 0;
    this.receivedBytes = 0;
    this.gaps = 0;
    this.sequenceErrors = 0;
  }
  send(message: object) {
    this.socket.send(JSON.stringify(message));
  }
  outputFrame(terminalId: number, seq: number) {
    const payload = Buffer.alloc(4096, 120);
    payload.writeDoubleBE(performance.now(), 0);
    payload.writeUInt32BE(seq, 8);
    this.socket.send(encodeDataFrame({ kind: "output", terminalId, seq, payload }));
  }
  probe(id: number) {
    if (this.pendingControls.size >= 32) throw new Error("Control probe backlog");
    this.pendingControls.set(id, performance.now());
    this.send({ type: "acquire-lease", terminalId: id });
  }
  async notice(type: string, action: () => void) {
    const before = this.notices.get(type)?.count ?? 0;
    action();
    await this.wait(() => (this.notices.get(type)?.count ?? 0) > before);
    return this.notices.get(type)!.message;
  }
  async wait(condition: () => boolean, timeoutMs = 5000) {
    await waitUntil(
      () => {
        this.check();
        return condition();
      },
      { timeoutMs },
    );
  }
  check() {
    if (this.error || this.closed !== undefined)
      throw new Error(this.error ?? `Peer closed: ${this.closed}`);
  }
  close() {
    this.socket.resume();
    this.socket.terminate();
  }
}

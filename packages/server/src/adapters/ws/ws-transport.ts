import type { Server as HttpServer } from "node:http";
import {
  encodeDataFrame,
  serializeServerMessage,
  type DataFrame,
  type ServerMessage,
} from "@ttyroom/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { Connection } from "../../ports/transport.js";

interface ServerCoreBoundary {
  handleMessage(connection: Connection, raw: string): void | Promise<void>;
  handleData(connection: Connection, bytes: Uint8Array): void | Promise<void>;
  handleClose(connection: Connection): void | Promise<void>;
}

export interface WsTransportErrorContext {
  connectionId: string;
  phase: "message" | "close" | "queue";
}

export class WsTransport {
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly httpServer: HttpServer;
  private readonly upgradeHandler: Parameters<HttpServer["on"]>[1];
  private nextConnectionNumber = 1;
  private shuttingDown = false;
  private closing: Promise<void> | undefined;
  private readonly processing = new Set<Promise<void>>();

  constructor(
    private readonly deps: { core: ServerCoreBoundary },
    private readonly options: {
      server: HttpServer;
      maxQueuedDataBytes?: number;
      onError?: (error: unknown, context: WsTransportErrorContext) => void;
    },
  ) {
    this.httpServer = options.server;
    this.upgradeHandler = (request, socket, head) => {
      if (this.shuttingDown) {
        socket.destroy();
        return;
      }
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path !== "/ws") {
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.attach(websocket);
      });
    };
    this.httpServer.on("upgrade", this.upgradeHandler);
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private attach(websocket: WebSocket): void {
    const connection = new WsConnection(`ws-${this.nextConnectionNumber}`, websocket);
    let processing = Promise.resolve();
    let queuedDataBytes = 0;
    let acceptingMessages = true;
    this.nextConnectionNumber += 1;

    websocket.on("message", (raw, isBinary) => {
      if (!acceptingMessages) return;
      const dataBytes = isBinary ? byteLengthOf(raw) : 0;
      if (queuedDataBytes + dataBytes > (this.options.maxQueuedDataBytes ?? 1048576)) {
        acceptingMessages = false;
        this.report(
          new Error("연결의 대기 중인 binary 데이터가 허용량을 초과했다"),
          connection,
          "queue",
        );
        connection.close();
        return;
      }
      queuedDataBytes += dataBytes;
      processing = processing
        .then(() =>
          isBinary
            ? this.deps.core.handleData(connection, bytesOf(raw))
            : this.deps.core.handleMessage(connection, raw.toString()),
        )
        .finally(() => {
          queuedDataBytes -= dataBytes;
        })
        .catch((error: unknown) => {
          acceptingMessages = false;
          this.report(error, connection, "message");
          connection.close();
        });
      this.track(processing);
    });
    websocket.once("close", () => {
      if (!this.shuttingDown) {
        processing = processing
          .then(() => this.deps.core.handleClose(connection))
          .catch((error: unknown) => this.report(error, connection, "close"));
        this.track(processing);
      }
    });
  }

  private track(task: Promise<void>): void {
    this.processing.add(task);
    void task.then(
      () => this.processing.delete(task),
      () => this.processing.delete(task),
    );
  }

  processingCount(): number {
    return this.processing.size;
  }

  private report(
    error: unknown,
    connection: Connection,
    phase: WsTransportErrorContext["phase"],
  ): void {
    try {
      this.options.onError?.(error, { connectionId: connection.connectionId, phase });
    } catch {}
  }

  private async closeOnce(): Promise<void> {
    this.shuttingDown = true;
    this.httpServer.off("upgrade", this.upgradeHandler);
    const clients = [...this.websocketServer.clients];
    const clientsClosed = Promise.all(
      clients.map(
        (websocket) =>
          new Promise<void>((resolve) => {
            if (websocket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            websocket.once("close", resolve);
          }),
      ),
    );
    for (const websocket of clients) websocket.terminate();
    const serverClosed = new Promise<void>((resolve, reject) => {
      this.websocketServer.close((error) => (error ? reject(error) : resolve()));
    });
    await Promise.all([clientsClosed, serverClosed]);
    await Promise.all(this.processing);
    this.processing.clear();
  }
}

class WsConnection implements Connection {
  constructor(
    readonly connectionId: string,
    private readonly websocket: WebSocket,
  ) {}

  send(message: ServerMessage): void {
    if (this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(serializeServerMessage(message));
  }

  sendData(frame: DataFrame): void {
    if (this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(encodeDataFrame(frame), { binary: true });
  }

  bufferedBytes(): number {
    return this.websocket.bufferedAmount;
  }

  close(): void {
    if (this.websocket.readyState === WebSocket.OPEN) this.websocket.close();
  }
}

function bytesOf(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) {
    const length = raw.reduce((total, part) => total + part.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const part of raw) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function byteLengthOf(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, part) => total + part.byteLength, 0);
  return raw.byteLength;
}

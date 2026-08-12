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
  handleMessage(connection: Connection, raw: string): void;
  handleData(connection: Connection, bytes: Uint8Array): void;
  handleClose(connection: Connection): void;
}

export class WsTransport {
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private nextConnectionNumber = 1;

  constructor(
    private readonly deps: { core: ServerCoreBoundary },
    options: { server: HttpServer },
  ) {
    options.server.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path !== "/ws") {
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.attach(websocket);
      });
    });
  }

  private attach(websocket: WebSocket): void {
    const connection = new WsConnection(`ws-${this.nextConnectionNumber}`, websocket);
    this.nextConnectionNumber += 1;

    websocket.on("message", (raw, isBinary) => {
      if (isBinary) {
        this.deps.core.handleData(connection, bytesOf(raw));
        return;
      }
      this.deps.core.handleMessage(connection, raw.toString());
    });
    websocket.once("close", () => this.deps.core.handleClose(connection));
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

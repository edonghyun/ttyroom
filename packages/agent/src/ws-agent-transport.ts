import WebSocket from "ws";
import {
  decodeDataFrame,
  encodeDataFrame,
  parseServerMessage,
  serializeClientMessage,
  type ClientMessage,
  type DataFrame,
  type ServerMessage,
} from "@ttyroom/protocol";
import type { AgentConnection, AgentTransport } from "./ports/agent-transport.js";

// ws 어댑터 — 직렬화·파싱 경계는 전부 여기. 원격발 malformed 프레임은 무시한다 (throw 금지)
class WsAgentConnection implements AgentConnection {
  private readonly messageHandlers: Array<(msg: ServerMessage) => void> = [];
  private readonly dataHandlers: Array<(frame: DataFrame) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const decoded = decodeDataFrame(new Uint8Array(raw));
        if (decoded.kind !== "ok") return;
        for (const handler of this.dataHandlers) handler(decoded.frame);
        return;
      }

      const parsed = parseServerMessage(raw.toString("utf8"));
      if (parsed.kind !== "ok") return;
      for (const handler of this.messageHandlers) handler(parsed.message);
    });

    ws.on("close", () => {
      for (const handler of this.closeHandlers) handler();
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(serializeClientMessage(msg));
  }

  sendData(frame: DataFrame): void {
    this.ws.send(encodeDataFrame(frame));
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onData(handler: (frame: DataFrame) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.ws.close();
  }
}

export class WsAgentTransport implements AgentTransport {
  connect(wsUrl: string): Promise<AgentConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.once("open", () => resolve(new WsAgentConnection(ws)));

      // open 전 실패는 reject(연결 시도 실패). open 후 오류는 close 이벤트로 표면화되므로
      // 여기서는 프로세스를 죽이는 unhandled 'error'만 삼킨다
      ws.on("error", (err) => reject(err));
    });
  }
}

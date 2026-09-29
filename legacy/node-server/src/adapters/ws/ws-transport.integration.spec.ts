import { createServer, type Server } from "node:http";
import {
  decodeDataFrame,
  parseServerMessage,
  type DataFrame,
  type ServerMessage,
} from "@ttyroom/protocol";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import type { Connection } from "../../ports/transport.js";
import { describeTransportContract, type TransportLink } from "../../test/transport-contract.js";
import { WsTransport } from "./ws-transport.js";

describeTransportContract("WsTransport", makeWsLink);

describe("WsTransport 고유 동작", () => {
  it("bufferedBytes는 열린 연결과 닫힌 연결에서 유효한 number를 반환한다", async () => {
    const link = await makeWsLink();
    expect(link.connection.bufferedBytes()).toBeGreaterThanOrEqual(0);
    link.connection.close();
    expect(link.connection.bufferedBytes()).toBeGreaterThanOrEqual(0);
    await link.onServerClose;
  });

  it("완료된 message와 close 작업을 processing 집합에서 제거한다", async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const link = await makeWsLink();
      link.remote.sendText(`message-${attempt}`);
      await link.flush();
      link.remote.close();
      await link.onServerClose;
      expect(link.transport.processingCount()).toBe(0);
    }
  });

  it("느린 제어 메시지 뒤 binary 대기량이 상한을 넘으면 연결을 닫고 오류를 보고한다", async () => {
    let releaseMessage: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const errors: Array<{ error: unknown; phase: string }> = [];
    const link = await makeWsLink({
      maxQueuedDataBytes: 12,
      beforeMessage: (raw) => (raw === "block" ? blocked : undefined),
      onError: (error, context) => errors.push({ error, phase: context.phase }),
    });

    link.remote.sendText("block");
    link.remote.sendBinary(new Uint8Array(8));
    link.remote.sendBinary(new Uint8Array(8));
    await waitUntil(() => errors.length === 1);
    releaseMessage?.();
    await link.onServerClose;

    expect(errors[0]?.phase).toBe("queue");
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(link.received.binaries).toHaveLength(1);
    expect(link.transport.processingCount()).toBe(0);
  });
});

async function makeWsLink(
  options: {
    maxQueuedDataBytes?: number;
    beforeMessage?: (raw: string) => void | Promise<void>;
    onError?: ConstructorParameters<typeof WsTransport>[1]["onError"];
  } = {},
): Promise<TransportLink & { transport: WsTransport }> {
  const received = { texts: [] as string[], binaries: [] as Uint8Array[] };
  let serverConnection: Connection | undefined;
  let closeCount = 0;
  let resolveClose: (() => void) | undefined;
  const closeObserved = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const core = {
    async handleMessage(connection: Connection, raw: string): Promise<void> {
      serverConnection = connection;
      await options.beforeMessage?.(raw);
      received.texts.push(raw);
    },
    handleData(connection: Connection, bytes: Uint8Array): void {
      serverConnection = connection;
      received.binaries.push(bytes.slice());
    },
    handleClose(): void {
      closeCount += 1;
      resolveClose?.();
    },
  };
  const server = createServer();
  const transport = new WsTransport(
    { core },
    {
      server,
      maxQueuedDataBytes: options.maxQueuedDataBytes,
      onError: options.onError,
    },
  );
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP 포트를 얻지 못했다");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const messages: ServerMessage[] = [];
  const dataFrames: DataFrame[] = [];
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      const decoded = decodeDataFrame(new Uint8Array(raw as Buffer));
      if (decoded.kind === "malformed") throw new Error(decoded.reason);
      dataFrames.push(decoded.frame);
      return;
    }
    const parsed = parseServerMessage(raw.toString());
    if (parsed.kind === "bad-message") throw new Error(parsed.reason);
    messages.push(parsed.message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send("__connection_probe__");
  await waitUntil(() => serverConnection !== undefined);
  received.texts.length = 0;
  const connection = serverConnection;
  if (!connection) throw new Error("서버 Connection이 생성되지 않았다");

  const onServerClose = closeObserved.then(async () => {
    await closeHttpServer(server);
  });
  return {
    transport,
    connection,
    remote: {
      messages,
      dataFrames,
      sendText(raw): void {
        if (socket.readyState === WebSocket.OPEN) socket.send(raw);
      },
      sendBinary(bytes): void {
        if (socket.readyState === WebSocket.OPEN) socket.send(bytes, { binary: true });
      },
      close(): void {
        if (socket.readyState === WebSocket.OPEN) socket.close();
      },
    },
    received,
    onServerClose,
    serverCloseCount: () => closeCount,
    flush: async (): Promise<void> => {
      await waitForTurn();
      await waitForTurn();
    },
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await waitForTurn();
  }
  throw new Error("조건을 기다리다 상한을 넘었다");
}

async function waitForTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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
});

async function makeWsLink(): Promise<TransportLink> {
  const received = { texts: [] as string[], binaries: [] as Uint8Array[] };
  let serverConnection: Connection | undefined;
  let closeCount = 0;
  let resolveClose: (() => void) | undefined;
  const closeObserved = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const core = {
    handleMessage(connection: Connection, raw: string): void {
      serverConnection = connection;
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
  new WsTransport({ core }, { server });
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

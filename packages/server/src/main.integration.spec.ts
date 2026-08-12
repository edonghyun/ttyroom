import { PROTOCOL_VERSION, parseServerMessage, serializeClientMessage } from "@ttyroom/protocol";
import WebSocket from "ws";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { startServer } from "./main.js";

describe("startServer — 역할: 조립과 HTTP 경계", () => {
  it("포트 0으로 부팅해 healthz가 200 ok다", async () => {
    const server = await startServer(loadConfig({}));
    try {
      const response = await fetch(`${server.httpBaseUrl}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await server.close();
    }
  });

  it("POST /api/rooms가 roomId·token·joinUrl을 발급한다", async () => {
    const server = await startServer(loadConfig({}));
    try {
      const response = await fetch(`${server.httpBaseUrl}/api/rooms`, { method: "POST" });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body.roomId).toEqual(expect.any(String));
      expect(body.token).toEqual(expect.any(String));
      expect(body.joinUrl).toBe(
        `${server.httpBaseUrl}/r/${String(body.roomId)}#${String(body.token)}`,
      );
    } finally {
      await server.close();
    }
  });

  it("POST /api/rooms의 표시 이름이 생성 응답과 welcome snapshot까지 이어진다", async () => {
    const server = await startServer(loadConfig({}));
    let socket: WebSocket | undefined;
    try {
      const issued = await fetch(`${server.httpBaseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Payment Debug" }),
      });
      const room = (await issued.json()) as { roomId: string; token: string; name: string };
      expect(room.name).toBe("Payment Debug");

      socket = new WebSocket(`${server.httpBaseUrl.replace("http", "ws")}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", resolve);
        socket?.once("error", reject);
      });
      socket.send(
        serializeClientMessage({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          roomId: room.roomId,
          token: room.token,
          clientId: "alice-named",
          name: "alice",
          role: "participant",
        }),
      );
      const raw = await new Promise<string>((resolve, reject) => {
        socket?.once("message", (data) => resolve(data.toString()));
        socket?.once("error", reject);
      });

      expect(parseServerMessage(raw)).toMatchObject({
        kind: "ok",
        message: { type: "welcome", snapshot: { name: "Payment Debug" } },
      });
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.terminate();
      await server.close();
    }
  });

  it("GET /와 /r/:roomId가 CSP와 no-store를 가진 동일한 SPA를 제공한다", async () => {
    const webRoot = await webFixture();
    const server = await startServer(loadConfig({}), { webRoot });
    try {
      const root = await fetch(`${server.httpBaseUrl}/`);
      const room = await fetch(`${server.httpBaseUrl}/r/room-1`);
      expect(root.status).toBe(200);
      expect(room.status).toBe(200);
      expect(room.headers.get("cache-control")).toBe("no-store");
      expect(room.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(await root.text()).toBe(await room.text());
    } finally {
      await server.close();
      await rm(webRoot, { recursive: true });
    }
  });

  it("정적 fallback이 API 또는 없는 asset을 가로채지 않는다", async () => {
    const webRoot = await webFixture();
    const server = await startServer(loadConfig({}), { webRoot });
    try {
      const api = await fetch(`${server.httpBaseUrl}/api/missing`);
      const asset = await fetch(`${server.httpBaseUrl}/assets/missing-Ab12.js`);
      expect(api.status).toBe(404);
      expect(asset.status).toBe(404);
      expect(await api.text()).not.toContain("TTYRoom built app");
      expect(await asset.text()).not.toContain("TTYRoom built app");
    } finally {
      await server.close();
      await rm(webRoot, { recursive: true });
    }
  });

  it("발급받은 Room에 실제 ws로 hello하면 welcome이 온다", async () => {
    const server = await startServer(loadConfig({}));
    let socket: WebSocket | undefined;
    try {
      const issued = await fetch(`${server.httpBaseUrl}/api/rooms`, { method: "POST" });
      const room = (await issued.json()) as { roomId: string; token: string };
      socket = new WebSocket(`${server.httpBaseUrl.replace("http", "ws")}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", resolve);
        socket?.once("error", reject);
      });

      socket.send(
        serializeClientMessage({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          roomId: room.roomId,
          token: room.token,
          clientId: "alice-1",
          name: "alice",
          role: "participant",
        }),
      );
      const raw = await new Promise<string>((resolve, reject) => {
        socket?.once("message", (data) => resolve(data.toString()));
        socket?.once("error", reject);
      });
      const parsed = parseServerMessage(raw);

      expect(parsed).toMatchObject({
        kind: "ok",
        message: { type: "welcome", selfClientId: "alice-1" },
      });
    } finally {
      if (socket?.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          socket?.once("close", resolve);
          socket?.close();
        });
      }
      await server.close();
    }
  });

  it("열린 WebSocket이 남아 있어도 서버 종료가 연결을 닫고 완료된다", async () => {
    const server = await startServer(loadConfig({}));
    const socket = new WebSocket(`${server.httpBaseUrl.replace("http", "ws")}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const socketClosed = new Promise<void>((resolve) => socket.once("close", resolve));
    const closing = server.close();
    const outcome = await Promise.race([
      Promise.all([closing, socketClosed]).then(() => "closed" as const),
      new Promise<"still-open">((resolve) => {
        setTimeout(() => resolve("still-open"), 250);
      }),
    ]);

    try {
      expect(outcome).toBe("closed");
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await closing;
    }
  });
});

async function webFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ttyroom-main-web-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><main>TTYRoom built app</main>");
  return root;
}

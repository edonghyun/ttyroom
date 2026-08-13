import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { LinkAuth } from "./adapters/link-auth/link-auth.js";
import { SqliteRoomRepository } from "./adapters/sqlite/sqlite-room-repository.js";
import { SystemClock } from "./adapters/system-clock/system-clock.js";
import { WsTransport } from "./adapters/ws/ws-transport.js";
import type { ServerConfig } from "./config.js";
import { RoomRegistry } from "./domain/room-registry.js";
import { HttpApi } from "./http/http-api.js";
import { StaticWebApp } from "./http/static-web-app.js";
import { ConnectionRegistry } from "./usecases/connection-registry.js";
import { ServerCore } from "./usecases/server-core.js";

export interface RunningServer {
  port: number;
  httpBaseUrl: string;
  close(): Promise<void>;
}

export async function startServer(
  config: ServerConfig,
  options: { readonly webRoot?: string } = {},
): Promise<RunningServer> {
  // 저장소 migration·검증·복원을 listen보다 먼저 끝낸다. 실패한 서버가 잠깐이라도
  // room-not-found를 응답하면 살아 있는 Agent가 영구 거절 상태로 들어갈 수 있다.
  const rooms = await RoomRegistry.restore(new SqliteRoomRepository(config.statePath));
  const connections = new ConnectionRegistry();
  const api = new HttpApi(rooms);
  const web = new StaticWebApp({
    root: options.webRoot ?? fileURLToPath(new URL("./web", import.meta.url)),
  });
  const httpServer = createServer((request, response) => {
    void (async () => {
      if (await api.handle(request, response)) return;
      if (await web.handle(request, response)) return;
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    })().catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("internal server error");
    });
  });
  const core = new ServerCore(
    {
      rooms,
      connections,
      identity: new LinkAuth(),
      clock: new SystemClock((error) => console.error("timer callback failed", error)),
    },
    {
      policy: config.policy,
      onBackgroundError: (error, task) => {
        console.error("disconnect grace task failed", task, error);
      },
    },
  );
  const transport = new WsTransport(
    { core },
    {
      server: httpServer,
      maxQueuedDataBytes: config.policy.maxQueuedDataBytesPerConnection,
      onError: (error, context) => {
        console.error("websocket processing failed", context, error);
      },
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(config.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await rooms.close();
    throw error;
  }
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer();
    await rooms.close();
    throw new Error("서버 포트를 확인할 수 없다");
  }

  let closed = false;

  async function closeHttpServer(): Promise<void> {
    if (!httpServer.listening) return;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    port: address.port,
    httpBaseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
        await closeHttpServer();
        await core.close();
      } finally {
        await rooms.close();
      }
    },
  };
}

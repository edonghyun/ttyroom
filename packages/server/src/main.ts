import { createServer } from "node:http";
import { LinkAuth } from "./adapters/link-auth/link-auth.js";
import { NoopSnapshotStore } from "./adapters/memory/noop-snapshot-store.js";
import { SystemClock } from "./adapters/system-clock/system-clock.js";
import { WsTransport } from "./adapters/ws/ws-transport.js";
import type { ServerConfig } from "./config.js";
import { RoomRegistry } from "./domain/room-registry.js";
import { HttpApi } from "./http.js";
import { ConnectionRegistry } from "./usecases/connection-registry.js";
import { ServerCore } from "./usecases/server-core.js";

export interface RunningServer {
  port: number;
  httpBaseUrl: string;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const rooms = new RoomRegistry();
  const connections = new ConnectionRegistry();
  const api = new HttpApi(rooms);
  const httpServer = createServer((request, response) => {
    void api.handle(request, response).catch(() => {
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
      clock: new SystemClock(),
      snapshots: new NoopSnapshotStore(),
    },
    { policy: config.policy },
  );
  const transport = new WsTransport({ core }, { server: httpServer });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer();
    throw new Error("서버 포트를 확인할 수 없다");
  }

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
      await transport.close();
      await closeHttpServer();
    },
  };
}

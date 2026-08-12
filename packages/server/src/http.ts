import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { RoomRegistry } from "./domain/room-registry.js";

export class HttpApi {
  constructor(private readonly rooms: RoomRegistry) {}

  handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const host = request.headers.host;
      if (!host) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("host header required");
        return;
      }
      const roomId = randomUUID();
      const token = randomBytes(24).toString("base64url");
      this.rooms.create({ roomId, token });
      this.sendJson(response, 201, {
        roomId,
        token,
        joinUrl: `http://${host}/r/${roomId}#${token}`,
      });
      return;
    }

    const roomPath = /^\/r\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && roomPath?.[1]) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`TTYRoom ${roomPath[1]}`);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }
}

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { RoomRegistry } from "../domain/room-registry.js";

const createRoomBodySchema = z.object({ name: z.string().trim().min(1).max(80).optional() });
const MAX_CREATE_ROOM_BODY_BYTES = 16 * 1024;

export class HttpApi {
  constructor(private readonly rooms: RoomRegistry) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const host = request.headers.host;
      if (!host) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("host header required");
        return true;
      }
      const body = await this.readCreateRoomBody(request);
      if (body.kind === "invalid") {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: body.reason }));
        return true;
      }

      const roomId = randomUUID();
      const token = randomBytes(24).toString("base64url");
      const room = await this.rooms.create({ roomId, token, name: body.name });
      this.sendJson(response, 201, {
        roomId,
        name: room.name,
        token,
        joinUrl: `http://${host}/r/${roomId}#${token}`,
      });
      return true;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not found" }));
      return true;
    }

    return false;
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private async readCreateRoomBody(
    request: IncomingMessage,
  ): Promise<{ kind: "ok"; name?: string } | { kind: "invalid"; reason: string }> {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += bytes.byteLength;
      if (byteCount > MAX_CREATE_ROOM_BODY_BYTES) {
        return { kind: "invalid", reason: "request body too large" };
      }
      chunks.push(bytes);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    let json: unknown = {};
    if (raw.length > 0) {
      try {
        json = JSON.parse(raw);
      } catch {
        return { kind: "invalid", reason: "invalid json" };
      }
    }
    const parsed = createRoomBodySchema.safeParse(json);
    return parsed.success
      ? { kind: "ok", name: parsed.data.name }
      : { kind: "invalid", reason: "invalid room name" };
  }
}

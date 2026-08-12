import { z } from "zod";

const createRoomResponseSchema = z.object({
  roomId: z.string().min(1),
  name: z.string().min(1),
  token: z.string().min(1),
  joinUrl: z.string().url(),
});

export type CreateRoomResult =
  | {
      kind: "created";
      roomId: string;
      name: string;
      token: string;
      joinUrl: string;
    }
  | { kind: "failed"; reason: "request-rejected" | "invalid-response" | "network-error" };

export interface RoomApiDeps {
  request(input: string, init: RequestInit): Promise<Response>;
}

export class RoomApi {
  constructor(
    private readonly deps: RoomApiDeps = {
      request: (input, init) => globalThis.fetch(input, init),
    },
  ) {}

  async createRoom(name: string, signal?: AbortSignal): Promise<CreateRoomResult> {
    let response: Response;
    try {
      response = await this.deps.request("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
        signal,
      });
    } catch {
      return { kind: "failed", reason: "network-error" };
    }

    if (!response.ok) return { kind: "failed", reason: "request-rejected" };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "failed", reason: "invalid-response" };
    }

    const parsed = createRoomResponseSchema.safeParse(body);
    return parsed.success
      ? { kind: "created", ...parsed.data }
      : { kind: "failed", reason: "invalid-response" };
  }
}

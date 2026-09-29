import { z } from "zod";

const credential = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const createRoomResponseSchema = z.object({
  roomId: z.string().min(1),
  name: z.string().min(1),
  token: z.string().min(1),
  joinUrl: z.string().url(),
  managerCredential: credential,
});
const participantSchema = z.object({ participantId: z.string().min(1), credential });
const hostSchema = z.object({ hostId: z.string().min(1), credential });
type Failure = {
  kind: "failed";
  reason: "request-rejected" | "invalid-response" | "network-error";
};
export type CreateRoomResult =
  ({ kind: "created" } & z.infer<typeof createRoomResponseSchema>) | Failure;
export type ParticipantRegistration =
  ({ kind: "registered" } & z.infer<typeof participantSchema>) | Failure;
export type HostRegistration = ({ kind: "registered" } & z.infer<typeof hostSchema>) | Failure;

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
    const result = await this.post("/api/rooms", { name }, createRoomResponseSchema, signal);
    return result.kind === "failed" ? result : { kind: "created", ...result.data };
  }

  async registerParticipant(roomId: string, token: string): Promise<ParticipantRegistration> {
    const result = await this.post(
      `/api/rooms/${encodeURIComponent(roomId)}/participants`,
      { token },
      participantSchema,
    );
    return result.kind === "failed" ? result : { kind: "registered", ...result.data };
  }

  async registerHost(roomId: string, managerCredential: string): Promise<HostRegistration> {
    const result = await this.post(
      `/api/rooms/${encodeURIComponent(roomId)}/hosts`,
      {},
      hostSchema,
      undefined,
      managerCredential,
    );
    return result.kind === "failed" ? result : { kind: "registered", ...result.data };
  }

  private async post<T>(
    path: string,
    body: object,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    manager?: string,
  ): Promise<{ kind: "ok"; data: T } | Failure> {
    let response: Response;
    try {
      response = await this.deps.request(path, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(manager ? { Authorization: `Bearer ${manager}` } : {}),
        },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(10_000),
      });
    } catch {
      return { kind: "failed", reason: "network-error" };
    }
    if (!response.ok) return { kind: "failed", reason: "request-rejected" };
    try {
      const parsed = schema.safeParse(await response.json());
      return parsed.success
        ? { kind: "ok", data: parsed.data }
        : { kind: "failed", reason: "invalid-response" };
    } catch {
      return { kind: "failed", reason: "invalid-response" };
    }
  }
}

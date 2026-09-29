import { z } from "zod";
import type { RoomApi, ParticipantRegistration } from "./room-api.js";

const identitySchema = z.object({
  clientId: z.string().min(1),
  nickname: z.string().min(1).optional(),
  registration: z
    .object({
      participantId: z.string().min(1),
      credential: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    })
    .optional(),
});

type IdentityRecord = z.infer<typeof identitySchema>;

export interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RoomIdentityDeps {
  storage: IdentityStorage;
  createId(): string;
}

export class RoomIdentity {
  private readonly identities = new Map<string, IdentityRecord>();

  private readonly registering = new Map<string, Promise<ParticipantRegistration>>();

  constructor(
    private readonly deps: RoomIdentityDeps = {
      storage: globalThis.sessionStorage,
      createId: () => globalThis.crypto.randomUUID(),
    },
  ) {}

  // Local tab/layout key only; it is never sent as an authenticated subject ID.
  clientId(roomId: string): string {
    return this.identity(roomId).clientId;
  }

  nickname(roomId: string): string | null {
    return this.identity(roomId).nickname ?? null;
  }

  saveNickname(roomId: string, nickname: string): void {
    const identity = { ...this.identity(roomId), nickname };
    this.identities.set(roomId, identity);
    this.persist(roomId, identity);
  }

  async register(roomId: string, token: string, api: RoomApi): Promise<ParticipantRegistration> {
    const record = this.identity(roomId);
    if (record.registration) return { kind: "registered", ...record.registration };
    const pending = this.registering.get(roomId);
    if (pending) return pending;
    const request = api
      .registerParticipant(roomId, token)
      .then((result) => {
        if (result.kind === "registered" && this.identity(roomId).clientId === record.clientId) {
          const identity = {
            ...this.identity(roomId),
            registration: { participantId: result.participantId, credential: result.credential },
          };
          this.identities.set(roomId, identity);
          this.persist(roomId, identity);
        }
        return result;
      })
      .finally(() => this.registering.delete(roomId));
    this.registering.set(roomId, request);
    return request;
  }

  renewClientId(roomId: string): string {
    const identity = { clientId: this.deps.createId(), nickname: this.identity(roomId).nickname };
    this.identities.set(roomId, identity);
    this.persist(roomId, identity);
    return identity.clientId;
  }

  private identity(roomId: string): IdentityRecord {
    const cached = this.identities.get(roomId);
    if (cached) return cached;

    const stored = this.read(roomId);
    if (stored) {
      this.identities.set(roomId, stored);
      return stored;
    }

    const created = { clientId: this.deps.createId() };
    this.identities.set(roomId, created);
    this.persist(roomId, created);
    return created;
  }

  private read(roomId: string): IdentityRecord | null {
    try {
      const raw = this.deps.storage.getItem(this.key(roomId));
      if (!raw) return null;

      const parsed: unknown = JSON.parse(raw);
      const identity = identitySchema.safeParse(parsed);
      return identity.success ? identity.data : null;
    } catch {
      return null;
    }
  }

  private persist(roomId: string, identity: IdentityRecord): void {
    try {
      this.deps.storage.setItem(this.key(roomId), JSON.stringify(identity));
    } catch {
      // The in-memory identity remains stable when browser storage is unavailable.
    }
  }

  private key(roomId: string): string {
    return `ttyroom:identity:v1:${encodeURIComponent(roomId)}`;
  }
}

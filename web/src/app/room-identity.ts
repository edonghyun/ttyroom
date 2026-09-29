import { z } from "zod";

const identitySchema = z.object({
  clientId: z.string().min(1),
  nickname: z.string().min(1).optional(),
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

  constructor(
    private readonly deps: RoomIdentityDeps = {
      storage: globalThis.sessionStorage,
      createId: () => globalThis.crypto.randomUUID(),
    },
  ) {}

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

  renewClientId(roomId: string): string {
    const identity = { ...this.identity(roomId), clientId: this.deps.createId() };
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

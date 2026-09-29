import { RoomApi, type HostRegistration } from "./room-api.js";
import type { IdentityStorage } from "./room-identity.js";

/** Manager authority is stored separately from invitation links and participant admission. */
export class RoomManagement {
  constructor(
    private readonly storage: IdentityStorage,
    private readonly api: RoomApi,
  ) {}

  remember(roomId: string, credential: string): boolean {
    try {
      this.storage.setItem(this.key(roomId), credential);
      return this.storage.getItem(this.key(roomId)) === credential;
    } catch {
      return false;
    }
  }

  async registerHost(roomId: string): Promise<HostRegistration | { kind: "unavailable" }> {
    let credential: string | null;
    try {
      credential = this.storage.getItem(this.key(roomId));
    } catch {
      return { kind: "unavailable" };
    }
    if (!credential) return { kind: "unavailable" };
    return this.api.registerHost(roomId, credential);
  }

  private key(roomId: string): string {
    return `ttyroom:manager:v1:${encodeURIComponent(roomId)}`;
  }
}

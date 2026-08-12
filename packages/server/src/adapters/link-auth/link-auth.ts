import type { HelloMessage } from "@ttyroom/protocol";
import type { Room } from "../../domain/room.js";
import type { AuthResult, Identity } from "../../ports/identity.js";

// MVP Identity — Room 토큰 일치 검사, 닉네임은 그대로 표시 이름으로 쓴다
export class LinkAuth implements Identity {
  authenticate(hello: HelloMessage, room: Room | undefined): AuthResult {
    if (!room) return { kind: "rejected", code: "room-not-found" };
    if (hello.token !== room.token) return { kind: "rejected", code: "invalid-token" };
    return { kind: "ok", clientId: hello.clientId, displayName: hello.name };
  }
}

import type { HelloMessage } from "@ttyroom/protocol";
import type { Room } from "../../domain/room.js";
import type { AuthResult, Identity } from "../../ports/identity.js";

// MVP Identity — Room 토큰 일치 검사, 닉네임은 그대로 표시 이름으로 쓴다.
// 신뢰 경계는 Room 토큰이다: 토큰 소지자가 제시한 clientId는 검증 없이 신뢰하므로
// 같은 Room 참여자 간 clientId 사칭은 MVP에서 수용된 위험 — 사칭 검증은
// Tailscale identity·SSO 어댑터가 이 포트를 대체할 때의 책임이다.
export class LinkAuth implements Identity {
  authenticate(hello: HelloMessage, room: Room | undefined): AuthResult {
    if (!room) return { kind: "rejected", code: "room-not-found" };
    if (!room.matchesToken(hello.token)) return { kind: "rejected", code: "invalid-token" };
    return { kind: "ok", clientId: hello.clientId, displayName: hello.name };
  }
}

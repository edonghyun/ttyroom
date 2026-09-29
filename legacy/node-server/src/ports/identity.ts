import type { HelloMessage } from "@ttyroom/protocol";
import type { Room } from "../domain/room.js";

export type AuthResult =
  | { kind: "ok"; clientId: string; displayName: string }
  | { kind: "rejected"; code: "invalid-token" | "room-not-found" };

// 연결 → (안정적 clientId, 표시 이름) 매핑. MVP 어댑터는 Room 토큰 + 닉네임,
// Tailscale identity·SSO 어댑터로 교체·병행 가능해야 한다.
export interface Identity {
  authenticate(hello: HelloMessage, room: Room | undefined): AuthResult;
}

import type { DataFrame, ServerMessage } from "@ttyroom/protocol";

// 의미론 계약:
// - send/sendData는 프레임 순서를 보존한다.
// - bufferedBytes는 아직 커널로 넘기지 못한 송신 대기 바이트 수다 (백프레셔 신호 —
//   감지는 어댑터, 드롭 정책 결정은 유즈케이스).
// - 재연결은 어댑터가 숨기지 않는다 — 끊기면 onClose가 반드시 한 번 불리고,
//   새 연결은 새 Connection이다 (세션 재개는 프로토콜 계층의 몫).
export interface Connection {
  readonly connectionId: string;
  send(message: ServerMessage): void;
  sendData(frame: DataFrame): void;
  bufferedBytes(): number;
  close(): void;
}

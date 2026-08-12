import type { DataFrame, ServerMessage } from "@ttyroom/protocol";

// 의미론 계약:
// - send/sendData는 프레임 순서를 보존한다.
// - bufferedBytes는 아직 커널로 넘기지 못한 송신 대기 바이트 수다 (백프레셔 신호 —
//   감지는 어댑터, 드롭 정책 결정은 유즈케이스).
// - 재연결은 어댑터가 숨기지 않는다 — 끊기면 어댑터가 close 통지를 정확히 한 번 발행하고,
//   새 연결은 새 Connection이다 (세션 재개는 프로토콜 계층의 몫).
//   close 통지(onClose) 등록은 이 인터페이스 밖 — 어댑터 배선 계약이며 Task 13
//   Transport 계약 스위트가 실행 가능한 테스트로 옮긴다.
export interface Connection {
  readonly connectionId: string;
  send(message: ServerMessage): void;
  sendData(frame: DataFrame): void;
  bufferedBytes(): number;
  close(): void;
}

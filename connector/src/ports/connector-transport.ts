import type { ClientMessage, DataFrame, ServerMessage } from "@ttyroom/protocol";

// connector 쪽 Transport 포트 — 연결 시도 하나가 ConnectorConnection 하나. 재접속은 새 connect 호출.
export interface ConnectorConnection {
  send(msg: ClientMessage): void;
  sendData(frame: DataFrame): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onData(handler: (frame: DataFrame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

// 연결 실패는 reject — 예상된 실패지만 시도 단위 경계라 Promise reject로 표현한다
export interface ConnectorTransport {
  connect(wsUrl: string): Promise<ConnectorConnection>;
}

// 서버 Clock과 동형 — 반환값은 취소 함수
export interface ConnectorClock {
  schedule(delayMs: number, fn: () => void): () => void;
}

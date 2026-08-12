import type { ClientMessage, DataFrame, HelloMessage, ServerMessage } from "@ttyroom/protocol";
import type { AgentClock, AgentConnection, AgentTransport } from "./ports/agent-transport.js";

export type SessionEvent =
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number; delayMs: number }
  // error 메시지 수신 — 재시도하지 않는 종료 (예: 버전 불일치)
  | { kind: "rejected"; code: string }
  | { kind: "server-message"; message: ServerMessage }
  | { kind: "server-data"; frame: DataFrame };

interface SessionDeps {
  transport: AgentTransport;
  clock: AgentClock;
}

interface SessionOptions {
  wsUrl: string;
  hello: HelloMessage;
  onEvent: (e: SessionEvent) => void;
}

// 재접속 백오프: 500ms * 2^(attempt-1), 상한 10초 — 순간 장애는 빠르게, 장기 장애는 서버를 두드리지 않게
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export class AgentSession {
  private attempt = 0;

  // 서버가 error로 거절한 세션 — 재시도해도 같은 답이라 영구 종료로 취급한다
  private rejected = false;

  private stopped = false;
  private cancelReconnect: (() => void) | null = null;
  private connection: AgentConnection | null = null;

  constructor(
    private readonly deps: SessionDeps,
    private readonly options: SessionOptions,
  ) {}

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    let connection;
    try {
      connection = await this.deps.transport.connect(this.options.wsUrl);
    } catch {
      // 연결 실패는 예상된 실패 — 끊김과 동일하게 백오프로 흡수한다
      this.scheduleReconnect();
      return;
    }

    // stop과 connect 완료의 경합 — 이미 멈춘 세션의 늦은 연결은 등록 없이 폐기한다
    if (this.stopped || this.rejected) {
      connection.close();
      return;
    }

    this.connection = connection;
    connection.onClose(() => {
      this.connection = null;
      this.scheduleReconnect();
    });
    connection.onMessage((msg) => this.handleServerMessage(msg));
    connection.onData((frame) => this.options.onEvent({ kind: "server-data", frame }));
    connection.send(this.options.hello);
    this.options.onEvent({ kind: "connected" });
  }

  private handleServerMessage(msg: ServerMessage): void {
    // welcome은 서버가 hello를 수락한 증거 — 여기부터 백오프를 처음부터 다시 센다
    if (msg.type === "welcome") this.attempt = 0;

    if (msg.type === "error") {
      this.rejected = true;
      this.options.onEvent({ kind: "rejected", code: msg.code });
      return;
    }

    this.options.onEvent({ kind: "server-message", message: msg });
  }

  private scheduleReconnect(): void {
    if (this.rejected || this.stopped) return;

    this.attempt += 1;
    const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
    this.options.onEvent({ kind: "reconnecting", attempt: this.attempt, delayMs });
    this.cancelReconnect = this.deps.clock.schedule(delayMs, () => void this.connect());
  }

  // 미연결이면 무시 — 출력은 서버 스크롤백이 아니라 재생성 불가, MVP 수용 (계획 Task 15)
  send(msg: ClientMessage): void {
    this.connection?.send(msg);
  }

  sendData(frame: DataFrame): void {
    this.connection?.sendData(frame);
  }

  stop(): void {
    this.stopped = true;
    this.cancelReconnect?.();
    this.connection?.close();
  }
}

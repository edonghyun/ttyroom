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

  // 계약: onEvent는 던지지 않아야 한다 — 던지면 프로그래머 오류. 세션은 상태 전이를
  // 완결한 뒤 콜백을 부르므로 예외가 새도 세션 상태는 깨지지 않지만, 격리는 하지 않는다.
  onEvent: (e: SessionEvent) => void;
}

// 재접속 백오프: 500ms * 2^(attempt-1), 상한 10초 — 순간 장애는 빠르게, 장기 장애는 서버를 두드리지 않게
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export class AgentSession {
  private attempt = 0;

  // 서버가 error로 거절한 세션 — 재시도해도 같은 답이라 영구 종료로 취급한다
  private rejected = false;

  private started = false;
  private stopped = false;
  private cancelReconnect: (() => void) | null = null;
  private connection: AgentConnection | null = null;

  constructor(
    private readonly deps: SessionDeps,
    private readonly options: SessionOptions,
  ) {}

  start(): void {
    // 재호출은 프로그래머 오류 — 연결 루프가 둘이 되면 백오프·이벤트가 중복된다
    if (this.started) throw new Error("AgentSession.start()는 한 번만 호출할 수 있다");
    this.started = true;

    void this.connect();
  }

  private async connect(): Promise<void> {
    let connection: AgentConnection;
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
    connection.onData((frame) => {
      if (this.rejected || this.stopped) return;
      this.options.onEvent({ kind: "server-data", frame });
    });
    connection.send(this.options.hello);
    this.options.onEvent({ kind: "connected" });
  }

  private handleServerMessage(msg: ServerMessage): void {
    // 종료된 세션에 늦게 도착한 프레임 차단 — close 후에도 이벤트를 흘리는 transport 구현이 있을 수 있다
    if (this.rejected || this.stopped) return;

    // welcome은 서버가 hello를 수락한 증거 — 여기부터 백오프를 처음부터 다시 센다
    if (msg.type === "welcome") this.attempt = 0;

    if (msg.type === "error") {
      this.rejected = true;
      this.options.onEvent({ kind: "rejected", code: msg.code });

      // 종료는 세션이 완결한다 — 서버가 닫아주기를 기다리지 않는다
      this.connection?.close();
      this.connection = null;
      return;
    }

    this.options.onEvent({ kind: "server-message", message: msg });
  }

  private scheduleReconnect(): void {
    if (this.rejected || this.stopped) return;

    this.attempt += 1;
    const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);

    // 타이머 예약이 이벤트 방출보다 먼저 — 콜백이 던져도 재접속 루프는 죽지 않는다
    this.cancelReconnect = this.deps.clock.schedule(delayMs, () => void this.connect());
    this.options.onEvent({ kind: "reconnecting", attempt: this.attempt, delayMs });
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

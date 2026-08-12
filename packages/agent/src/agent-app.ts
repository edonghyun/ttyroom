import type { ClientMessage, DataFrame, ServerMessage } from "@ttyroom/protocol";
import type { SessionEvent } from "./session.js";

// 소비자 관점 포트 — AgentApp이 쓰는 표면만. 실제 AgentSession·PtyManager가 구조적으로 만족한다
export interface SessionPort {
  send(msg: ClientMessage): void;
  sendData(frame: DataFrame): void;
}

export interface PtyPort {
  open(terminalId: number, cols: number, rows: number): void;
  write(terminalId: number, data: Uint8Array): void;
  resize(terminalId: number, cols: number, rows: number): void;
  close(terminalId: number): void;
}

interface AgentAppDeps {
  session: SessionPort;
  ptys: PtyPort;
}

interface AgentAppOptions {
  onStatus: (line: string) => void;
}

// 서버 명령과 PTY 사이의 얇은 배선 — 판단은 서버에, 유일한 로컬 판단은 Kill Switch (스펙)
export class AgentApp {
  // Kill Switch — 서버를 거치지 않는 유일한 로컬 판단. 켜져 있으면 모든 원격 입력을 즉시 차단 (스펙)
  private killSwitchOn = false;
  private readonly outputSeqs = new Map<number, number>();

  constructor(
    private readonly deps: AgentAppDeps,
    private readonly options: AgentAppOptions,
  ) {}

  handleEvent(event: SessionEvent): void {
    switch (event.kind) {
      case "server-message":
        this.handleServerMessage(event.message);
        return;
      case "server-data":
        if (event.frame.kind === "input" && !this.killSwitchOn) {
          this.deps.ptys.write(event.frame.terminalId, event.frame.payload);
        }
        return;
      case "connected":
        this.options.onStatus("서버에 연결됨");
        return;
      case "reconnecting":
        this.options.onStatus(`재접속 대기 중 (시도 ${event.attempt}, ${event.delayMs}ms 후)`);
        return;
      case "rejected":
        this.options.onStatus(`서버가 세션을 거절함: ${event.code} — 재시도하지 않음`);
        return;
    }
  }

  setKillSwitch(on: boolean): void {
    this.killSwitchOn = on;

    // Host Owner가 동작을 신뢰하려면 상태가 보여야 한다 (스펙 "Host Owner 차단권")
    this.options.onStatus(
      on ? "Kill Switch ON — 원격 입력 차단됨" : "Kill Switch OFF — 원격 입력 허용",
    );
  }

  killSwitch(): boolean {
    return this.killSwitchOn;
  }

  // 조립부가 PtyManager의 onOutput/onExit 옵션에 이 메서드들을 배선한다
  handlePtyOutput(terminalId: number, chunk: Uint8Array): void {
    // seq는 agent 로컬 단조 증가 — 서버가 브로드캐스트 시 재부여한다 (계획 Task 17)
    const seq = (this.outputSeqs.get(terminalId) ?? 0) + 1;
    this.outputSeqs.set(terminalId, seq);
    this.deps.session.sendData({ kind: "output", terminalId, seq, payload: chunk });
  }

  handlePtyExit(terminalId: number, exitCode: number | null): void {
    this.deps.session.send({ type: "terminal-closed", terminalId, exitCode });
  }

  private handleServerMessage(msg: ServerMessage): void {
    if (msg.type === "open-terminal") {
      this.deps.ptys.open(msg.terminalId, msg.cols, msg.rows);
      this.deps.session.send({ type: "terminal-opened", terminalId: msg.terminalId });
      return;
    }

    // terminal-closed 회신은 여기서 보내지 않는다 — 명령발 close도 실제 exit이
    // PtyManager.onExit으로 표면화되며, 보고 경로는 그 하나뿐이다 (이중 보고 금지)
    if (msg.type === "close-terminal") {
      this.deps.ptys.close(msg.terminalId);
      return;
    }

    if (msg.type === "resize") {
      this.deps.ptys.resize(msg.terminalId, msg.cols, msg.rows);
    }
  }
}

import type { ClientMessage, DataFrame, ServerMessage } from "@ttyroom/protocol";
import { OutputReplayBuffer } from "./output-replay-buffer.js";
import type { SessionEvent } from "./session.js";

// 소비자 관점 포트 — AgentApp이 쓰는 표면만. 실제 AgentSession·PtyManager가 구조적으로 만족한다
export interface SessionPort {
  send(msg: ClientMessage): void;
  sendData(frame: DataFrame): void;
}

export interface PtyPort {
  open(terminalId: number, cols: number, rows: number): string;
  inventory(): Array<{ terminalId: number; runtimeId: string }>;
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

  // 부가 관찰자(MetaCollector)의 배선점 — 실제로 연 터미널만 알린다.
  // Kill Switch로 차단된 open까지 추적하면 exit이 없어 untrack 기회가 영영 오지 않는다
  onTerminalOpened: (terminalId: number) => void;
  outputReplayBytesPerTerminal?: number;
}

// 서버 명령과 PTY 사이의 얇은 배선 — 판단은 서버에, 유일한 로컬 판단은 Kill Switch (스펙)
export class AgentApp {
  // Kill Switch — 서버를 거치지 않는 유일한 로컬 판단. 켜져 있으면 모든 원격 입력을 즉시 차단 (스펙)
  private killSwitchOn = false;
  private serverReady = false;
  private readonly outputSeqs = new Map<number, number>();
  private readonly outputBuffers = new Map<number, OutputReplayBuffer>();

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
        if (event.frame.kind === "input" && this.serverReady && !this.killSwitchOn) {
          this.deps.ptys.write(event.frame.terminalId, event.frame.payload);
        }
        return;
      case "connected":
        this.serverReady = false;
        this.options.onStatus("서버에 연결됨");
        return;
      case "reconnecting":
        this.serverReady = false;
        this.options.onStatus(`재접속 대기 중 (시도 ${event.attempt}, ${event.delayMs}ms 후)`);
        return;
      case "rejected":
        this.options.onStatus(`서버가 세션을 거절함: ${event.code} — 재시도하지 않음`);
        return;
    }
  }

  setKillSwitch(on: boolean): void {
    this.killSwitchOn = on;
    if (this.serverReady) this.reportRemoteInputState();

    // Host Owner가 동작을 신뢰하려면 상태가 보여야 한다 (스펙 "Host Owner 차단권")
    this.options.onStatus(
      on ? "Kill Switch ON — 원격 입력 차단됨" : "Kill Switch OFF — 원격 입력 허용",
    );
  }

  killSwitch(): boolean {
    return this.killSwitchOn;
  }

  private reportRemoteInputState(): void {
    this.deps.session.send({
      type: "host-input-state",
      remoteInputAllowed: !this.killSwitchOn,
    });
  }

  // 조립부가 PtyManager의 onOutput/onExit 옵션에 이 메서드들을 배선한다
  handlePtyOutput(terminalId: number, chunk: Uint8Array): void {
    // seq는 agent 로컬 단조 증가 — 서버가 브로드캐스트 시 재부여한다 (계획 Task 17)
    const seq = (this.outputSeqs.get(terminalId) ?? 0) + 1;
    this.outputSeqs.set(terminalId, seq);
    const frame = { kind: "output" as const, terminalId, seq, payload: chunk };
    this.outputBuffer(terminalId).append(frame);
    if (this.serverReady) this.deps.session.sendData(frame);
  }

  handlePtyExit(terminalId: number, exitCode: number | null): void {
    // terminalId는 Room 단위 비재사용(서버 계약) — 정확성이 아니라 장수 프로세스의 맵 성장 방지
    this.outputSeqs.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    this.deps.session.send({ type: "terminal-closed", terminalId, exitCode });
  }

  private handleServerMessage(msg: ServerMessage): void {
    if (msg.type === "welcome") {
      this.serverReady = false;
      this.deps.session.send({
        type: "host-inventory",
        terminals: this.deps.ptys.inventory().map(({ terminalId, runtimeId }) => ({
          terminalId,
          runtimeId,
          ...this.outputBuffer(terminalId).inventory(),
        })),
      });
      return;
    }

    if (msg.type === "host-ready") {
      for (const terminal of msg.terminals) {
        const buffer = this.outputBuffer(terminal.terminalId);
        for (const frame of buffer.framesAfter(terminal.replayAfterSeq)) {
          this.deps.session.sendData(frame);
        }
        this.deps.session.send({
          type: "terminal-replay-complete",
          terminalId: terminal.terminalId,
          lastOutputSeq: buffer.inventory().lastOutputSeq,
        });
      }
      this.serverReady = true;
      this.reportRemoteInputState();
      return;
    }

    if (msg.type === "open-terminal") {
      // Kill Switch 범위 (T3.3 리뷰 확정 계약): 입력 프레임과 open-terminal(새 셸 스폰)은 차단,
      // resize·close-terminal은 실행 능력이 없고 차단하면 서버 상태와 어긋나므로 통과시킨다.
      // 차단된 open은 terminal-closed{exitCode:null}로 즉시 회신해 서버의 pending 터미널을 정리한다.
      if (this.killSwitchOn) {
        this.deps.session.send({
          type: "terminal-closed",
          terminalId: msg.terminalId,
          exitCode: null,
        });
        return;
      }

      try {
        const runtimeId = this.deps.ptys.open(msg.terminalId, msg.cols, msg.rows);
        this.outputBuffer(msg.terminalId);
        this.deps.session.send({
          type: "terminal-opened",
          terminalId: msg.terminalId,
          runtimeId,
        });
      } catch {
        // 셸 경로·호스트 자원 문제는 예상 가능한 운영 실패다. 원인을 로그에 싣지 않아
        // 로컬 경로·환경을 원격 상태나 공유 로그에 노출하지 않는다.
        this.options.onStatus(`터미널 ${msg.terminalId} 생성 실패`);
        this.deps.session.send({
          type: "terminal-closed",
          terminalId: msg.terminalId,
          exitCode: null,
        });
        return;
      }
      this.options.onTerminalOpened(msg.terminalId);
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

  private outputBuffer(terminalId: number): OutputReplayBuffer {
    let buffer = this.outputBuffers.get(terminalId);
    if (!buffer) {
      buffer = new OutputReplayBuffer({
        maxBytes: this.options.outputReplayBytesPerTerminal ?? 1_048_576,
      });
      this.outputBuffers.set(terminalId, buffer);
    }
    return buffer;
  }
}

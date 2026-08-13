import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { AgentClock } from "./ports/agent-transport.js";
import { RateLimiter } from "./rate-limiter.js";

interface PtyManagerDeps {
  clock: AgentClock;
}

interface PtyManagerOptions {
  shell?: string;
  rateLimitBytesPerSec: number;
  onOutput: (terminalId: number, chunk: Uint8Array) => void;
  onExit: (terminalId: number, exitCode: number | null) => void;
}

interface TrackedTerminal {
  runtimeId: string;
  pty: IPty;
  limiter: RateLimiter;

  // close 후 실제 exit까지의 2단계 상태 — 외부 관점은 이미 닫혔지만(조작 무시·조회 null)
  // 종료 보고(onExit)는 실제 exit에서 정확히 한 번 나간다 (계획 1854행: 모든 종료는 표면화)
  closing: boolean;

  // 터미널별 stateful 디코더 — 멀티바이트 문자가 입력 프레임 경계에 걸쳐도 손상되지 않게
  inputDecoder: TextDecoder;
}

// 원격발 수치가 ioctl(TIOCSWINSZ)에 닿는다 — protocol 검증과 별개로 여기서도 하한·상한을 조인다
// (F1 교훈: 원격 입력이 로컬 시스템 콜에 닿는 수치는 방어를 이중으로). u16 상한은 winsize 필드 크기.
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 65_535;

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_DIMENSION;
  return Math.min(Math.max(Math.floor(value), MIN_DIMENSION), MAX_DIMENSION);
}

// 판단 없이 PTY를 수행하는 얇은 실행자 — 어떤 터미널을 열고 닫을지는 서버가 정한다 (스펙)
export class PtyManager {
  private readonly terminals = new Map<number, TrackedTerminal>();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly deps: PtyManagerDeps,
    private readonly options: PtyManagerOptions,
  ) {}

  open(terminalId: number, cols: number, rows: number): string {
    // 중복 open은 무시 — 재접속·재전송 경합을 수용하고 기존 셸을 지킨다 (얇은 Agent: 판단은 서버에)
    const existing = this.terminals.get(terminalId);
    if (existing) return existing.runtimeId;

    const shell = this.options.shell ?? process.env["SHELL"] ?? "/bin/sh";
    const pty = spawn(shell, [], {
      name: "xterm-256color",
      cols: clampDimension(cols),
      rows: clampDimension(rows),
      cwd: process.cwd(),
      // undefined 값은 node-pty가 무시하므로 안전 — ProcessEnv와 Record의 타입 차이만 좁힌다
      env: process.env as Record<string, string>,
    });

    // 터미널마다 독립 버킷 — 한 터미널의 폭주가 다른 터미널의 출력을 막지 못하게.
    // 버스트는 1초 분량: 순간 출력(화면 다시 그리기)은 즉시, 지속 폭주만 지연
    const limiter = new RateLimiter(
      { clock: this.deps.clock },
      {
        bytesPerSec: this.options.rateLimitBytesPerSec,
        burstBytes: this.options.rateLimitBytesPerSec,
      },
    );

    const tracked: TrackedTerminal = {
      runtimeId: randomUUID(),
      pty,
      limiter,
      closing: false,
      inputDecoder: new TextDecoder(),
    };
    this.terminals.set(terminalId, tracked);

    // 동일성 가드 — close()로 이미 제거(또는 교체)된 터미널의 늦은 콜백을 차단한다
    pty.onData((data) => {
      if (this.terminals.get(terminalId) !== tracked) return;
      limiter.submit(this.encoder.encode(data), (chunk) =>
        this.options.onOutput(terminalId, chunk),
      );
    });
    pty.onExit(({ exitCode, signal }) => {
      if (this.terminals.get(terminalId) !== tracked) return;
      this.terminals.delete(terminalId);

      // 리미터 잔여는 종료 보고 전에 비운다 — onExit(→terminal-closed, 계획 1854행) 뒤에
      // 도착하는 출력은 소비자가 버리므로 꼬리 출력이 사실상 드롭된다. 종료 시점의 순간
      // 초과는 무해(상한의 목적은 터미널 간 공정성). deliver가 던져도 종료 표면화는 보장.
      try {
        tracked.limiter.flush();
      } finally {
        // 시그널 종료는 exitCode null — protocol의 int|null에서 null은 "정상 종료 코드 없음"
        // (PROTOCOL.md는 형태만 정의 — 의미 서술 갱신은 protocol R&R 소관)
        this.options.onExit(terminalId, signal ? null : exitCode);
      }
    });
    return tracked.runtimeId;
  }

  inventory(): Array<{ terminalId: number; runtimeId: string }> {
    return [...this.terminals]
      .filter(([, terminal]) => !terminal.closing)
      .map(([terminalId, terminal]) => ({ terminalId, runtimeId: terminal.runtimeId }));
  }

  write(terminalId: number, data: Uint8Array): void {
    const tracked = this.activeTerminal(terminalId);
    if (!tracked) return;

    tracked.pty.write(tracked.inputDecoder.decode(data, { stream: true }));
  }

  resize(terminalId: number, cols: number, rows: number): void {
    const tracked = this.activeTerminal(terminalId);
    if (!tracked) return;

    tracked.pty.resize(clampDimension(cols), clampDimension(rows));
  }

  close(terminalId: number): void {
    const tracked = this.activeTerminal(terminalId);
    if (!tracked) return;

    // kill 기본 신호는 SIGHUP — 대상이 사용자 셸이라 이것으로 죽는다. 신호를 무시하는
    // 자식의 SIGKILL 에스컬레이션은 넣지 않는다: MVP에서 실익 대비 타이머 상태만 늘고,
    // Host Owner는 로컬에서 직접 정리할 수 있으며 agent 종료 시 마스터 fd가 닫힌다.
    tracked.closing = true;
    tracked.pty.kill();
  }

  fgProcess(terminalId: number): string | null {
    return this.activeTerminal(terminalId)?.pty.process ?? null;
  }

  pid(terminalId: number): number | null {
    return this.activeTerminal(terminalId)?.pty.pid ?? null;
  }

  closeAll(): void {
    for (const terminalId of [...this.terminals.keys()]) this.close(terminalId);
  }

  // closing 터미널은 외부 관점에서 이미 닫힘 — exit 대기 중에도 조작·조회를 받지 않는다
  private activeTerminal(terminalId: number): TrackedTerminal | undefined {
    const tracked = this.terminals.get(terminalId);
    if (!tracked || tracked.closing) return undefined;
    return tracked;
  }
}

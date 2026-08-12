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
  pty: IPty;
  limiter: RateLimiter;
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
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly deps: PtyManagerDeps,
    private readonly options: PtyManagerOptions,
  ) {}

  open(terminalId: number, cols: number, rows: number): void {
    // 중복 open은 무시 — 재접속·재전송 경합을 수용하고 기존 셸을 지킨다 (얇은 Agent: 판단은 서버에)
    if (this.terminals.has(terminalId)) return;

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

    const tracked: TrackedTerminal = { pty, limiter };
    this.terminals.set(terminalId, tracked);

    // 동일성 가드 — close()로 이미 제거(또는 교체)된 터미널의 늦은 콜백을 차단한다
    pty.onData((data) => {
      if (this.terminals.get(terminalId) !== tracked) return;
      limiter.submit(this.encoder.encode(data), (chunk) =>
        this.options.onOutput(terminalId, chunk),
      );
    });
    pty.onExit(({ exitCode }) => {
      if (this.terminals.get(terminalId) !== tracked) return;
      this.terminals.delete(terminalId);
      this.options.onExit(terminalId, exitCode ?? null);
    });
  }

  write(terminalId: number, data: Uint8Array): void {
    const tracked = this.terminals.get(terminalId);
    if (!tracked) return;

    tracked.pty.write(this.decoder.decode(data));
  }

  resize(terminalId: number, cols: number, rows: number): void {
    const tracked = this.terminals.get(terminalId);
    if (!tracked) return;

    tracked.pty.resize(clampDimension(cols), clampDimension(rows));
  }

  close(terminalId: number): void {
    const tracked = this.terminals.get(terminalId);
    if (!tracked) return;

    this.terminals.delete(terminalId);
    tracked.pty.kill();
  }

  fgProcess(terminalId: number): string | null {
    return this.terminals.get(terminalId)?.pty.process ?? null;
  }

  pid(terminalId: number): number | null {
    return this.terminals.get(terminalId)?.pty.pid ?? null;
  }

  closeAll(): void {
    for (const [, tracked] of this.terminals) tracked.pty.kill();
    this.terminals.clear();
  }
}

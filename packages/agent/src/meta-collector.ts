import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { TerminalMeta } from "@ttyroom/protocol";
import type { AgentClock } from "./ports/agent-transport.js";

const execFileAsync = promisify(execFile);

// 소비자 관점 포트 — 수집에 필요한 조회 표면만 (PtyManager가 구조적으로 만족)
export interface MetaSource {
  pid(terminalId: number): number | null;
  fgProcess(terminalId: number): string | null;
}

interface MetaCollectorDeps {
  ptys: MetaSource;
  clock: AgentClock;
}

interface MetaCollectorOptions {
  intervalMs: number;
  onMeta: (terminalId: number, meta: TerminalMeta) => void;
}

// cwd·git 브랜치·포그라운드 프로세스명을 폴링으로 수집 — 실패는 null (수집은 부가 정보, 절대 throw 금지)
export class MetaCollector {
  private readonly tracked = new Set<number>();
  private cancelTick: (() => void) | null = null;

  constructor(
    private readonly deps: MetaCollectorDeps,
    private readonly options: MetaCollectorOptions,
  ) {}

  track(terminalId: number): void {
    this.tracked.add(terminalId);
    this.scheduleTick();
  }

  untrack(terminalId: number): void {
    this.tracked.delete(terminalId);

    if (this.tracked.size === 0) {
      this.cancelTick?.();
      this.cancelTick = null;
    }
  }

  private scheduleTick(): void {
    if (this.cancelTick || this.tracked.size === 0) return;

    this.cancelTick = this.deps.clock.schedule(this.options.intervalMs, () => {
      this.cancelTick = null;
      this.scheduleTick();

      for (const terminalId of this.tracked) void this.collect(terminalId);
    });
  }

  private async collect(terminalId: number): Promise<void> {
    const pid = this.deps.ptys.pid(terminalId);
    if (pid === null) return;

    const fgProcess = this.deps.ptys.fgProcess(terminalId);
    const cwd = await readCwd(pid);
    const gitBranch = cwd === null ? null : await readGitBranch(cwd);

    // 수집 중 터미널이 닫혔으면 보고하지 않는다
    if (this.deps.ptys.pid(terminalId) === null || !this.tracked.has(terminalId)) return;

    this.options.onMeta(terminalId, { cwd, gitBranch, fgProcess });
  }
}

async function readCwd(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") return await readlink(`/proc/${pid}/cwd`);

    if (process.platform === "darwin") {
      // -Fn 출력에서 "n"으로 시작하는 라인이 경로다
      const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const line = stdout.split("\n").find((l) => l.startsWith("n"));
      return line ? line.slice(1) : null;
    }

    return null;
  } catch {
    return null;
  }
}

async function readGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const branch = stdout.trim();
    return branch === "" ? null : branch;
  } catch {
    return null;
  }
}

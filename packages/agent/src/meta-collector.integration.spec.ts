import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalMeta } from "@ttyroom/protocol";
import { MetaCollector } from "./meta-collector.js";
import { PtyManager } from "./pty-manager.js";
import { systemClock } from "./system-clock.js";
import { FakeClock } from "./test/fake-clock.js";
import { waitUntil } from "./test/wait-until.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeGitDir(branch: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ttyroom-meta-")));
  execFileSync("git", ["init", "-b", branch, dir]);
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("MetaCollector — 역할: 터미널 카드 자동 맥락 수집", () => {
  it("이전 폴링이 끝나기 전에는 같은 터미널의 외부 수집을 중첩하지 않는다", async () => {
    const clock = new FakeClock();
    const metas: TerminalMeta[] = [];
    const collector = new MetaCollector(
      {
        ptys: { pid: () => process.pid, fgProcess: () => "node" },
        clock,
      },
      { intervalMs: 1000, onMeta: (_terminalId, meta) => metas.push(meta) },
    );

    collector.track(1);
    clock.advance(1000);
    // 첫 collect가 readlink/lsof await에 머문 같은 이벤트 루프에서 다음 틱도 발화시킨다.
    clock.advance(1000);
    await waitUntil(() => metas.length > 0);

    expect(metas).toHaveLength(1);

    clock.advance(1000);
    await waitUntil(() => metas.length === 2);
  });

  it("실제 PTY의 cwd와 fgProcess를 수집한다 (git 저장소면 브랜치 포함)", async () => {
    const gitDir = makeGitDir("test-branch");
    const chunks: string[] = [];
    const manager = new PtyManager(
      { clock: systemClock },
      {
        shell: "/bin/sh",
        rateLimitBytesPerSec: 1 << 20,
        onOutput: (_id, c) => chunks.push(new TextDecoder().decode(c)),
        onExit: () => {},
      },
    );
    cleanups.push(() => manager.closeAll());

    const clock = new FakeClock();
    const metas: Array<{ terminalId: number; meta: TerminalMeta }> = [];
    const collector = new MetaCollector(
      { ptys: manager, clock },
      { intervalMs: 5000, onMeta: (terminalId, meta) => metas.push({ terminalId, meta }) },
    );

    manager.open(1, 80, 24);
    manager.write(1, new TextEncoder().encode(`cd ${gitDir} && echo cd-"done"\n`));
    await waitUntil(() => chunks.join("").includes("cd-done"));

    collector.track(1);
    clock.advance(5000);
    await waitUntil(() => metas.length > 0, { timeoutMs: 10_000 });

    const meta = metas[0]?.meta;
    if (!meta) throw new Error("meta가 수집돼야 한다");

    if (meta.cwd !== null) {
      expect(meta.cwd).toBe(gitDir);
      expect(meta.gitBranch).toBe("test-branch");
    } else {
      // darwin lsof가 실패하는 환경 폴백 — cwd는 null을 허용하되 fgProcess는 있어야 한다 (계획)
      expect(meta.fgProcess).not.toBeNull();
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { PtyManager } from "./pty-manager.js";
import { systemClock } from "./system-clock.js";
import { waitUntil } from "./test/wait-until.js";

/**
 * 상태×이벤트 전이표 (terminalId 단위) — 아래 테스트들이 각 칸을 핀한다.
 *
 * | 상태 \ 이벤트 | open           | write     | resize          | close           | PTY exit                        |
 * |--------------|----------------|-----------|-----------------|-----------------|---------------------------------|
 * | absent       | spawn → tracked| 무시      | 무시            | 무시            | —                               |
 * | tracked      | 무시(기존 유지)| pty.write | clamp 후 resize | kill → closing  | 제거·잔여 flush → onExit(exitCode)|
 * | closing      | 무시           | 무시      | 무시            | 무시            | 제거·잔여 flush → onExit(null)   |
 *
 * closeAll = 모든 tracked에 close. fgProcess·pid는 tracked(비closing)면 값, 아니면 null.
 * 모든 PTY 종료(자연·명령발)는 onExit으로 정확히 한 번 표면화 — 계획 1854행의 terminal-closed 배선 계약.
 */

interface Harness {
  manager: PtyManager;
  chunks: Uint8Array[];
  exits: Array<{ terminalId: number; exitCode: number | null }>;
  text: () => string;
}

const managers: PtyManager[] = [];

function makeManager(options: { rateLimitBytesPerSec?: number } = {}): Harness {
  const chunks: Uint8Array[] = [];
  const exits: Array<{ terminalId: number; exitCode: number | null }> = [];
  const manager = new PtyManager(
    { clock: systemClock },
    {
      shell: "/bin/sh",
      rateLimitBytesPerSec: options.rateLimitBytesPerSec ?? 1 << 20,
      onOutput: (_id, chunk) => chunks.push(chunk),
      onExit: (terminalId, exitCode) => exits.push({ terminalId, exitCode }),
    },
  );
  managers.push(manager);
  const decoder = new TextDecoder();
  return { manager, chunks, exits, text: () => chunks.map((c) => decoder.decode(c)).join("") };
}

function encode(command: string): Uint8Array {
  return new TextEncoder().encode(command);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
});

describe("PtyManager — 역할: 실제 셸의 생성과 입출력", () => {
  it("open은 PTY 수명 runtimeId를 만들고 inventory에서 같은 ID를 보고한다", () => {
    const { manager } = makeManager();

    const first = manager.open(1, 80, 24);
    const duplicate = manager.open(1, 120, 40);

    expect(first).toEqual(expect.any(String));
    expect(duplicate).toBe(first);
    expect(manager.inventory()).toEqual([{ terminalId: 1, runtimeId: first }]);
  });

  it("open한 셸에 echo를 쓰면 출력 콜백으로 되돌아온다", async () => {
    const { manager, text } = makeManager();

    manager.open(1, 80, 24);
    manager.write(1, encode("echo ttyroom-ok\n"));

    await waitUntil(() => text().includes("ttyroom-ok"));
  });

  it("셸이 exit하면 onExit이 종료 코드와 함께 불린다", async () => {
    const { manager, exits } = makeManager();

    manager.open(1, 80, 24);
    manager.write(1, encode("exit 3\n"));

    await waitUntil(() => exits.length > 0);
    expect(exits).toEqual([{ terminalId: 1, exitCode: 3 }]);
  });

  it("exit한 터미널에 대한 write·resize·close는 무시되고 pid·fgProcess는 null이다", async () => {
    const { manager, exits } = makeManager();

    manager.open(1, 80, 24);
    manager.write(1, encode("exit 0\n"));
    await waitUntil(() => exits.length > 0);

    expect(() => {
      manager.write(1, encode("echo ghost\n"));
      manager.resize(1, 100, 30);
      manager.close(1);
    }).not.toThrow();
    expect(manager.pid(1)).toBeNull();
    expect(manager.fgProcess(1)).toBeNull();
  });

  it("close하면 셸이 종료되고 onExit이 정확히 한 번 보고된다 (명령발 종료도 서버에 표면화)", async () => {
    const { manager, exits } = makeManager();

    manager.open(1, 80, 24);
    const pid = manager.pid(1);
    if (pid === null) throw new Error("open 직후 pid가 있어야 한다");

    manager.close(1);

    expect(manager.pid(1)).toBeNull();
    expect(manager.fgProcess(1)).toBeNull();
    expect(() => {
      manager.write(1, encode("echo ghost\n"));
      manager.close(1);
    }).not.toThrow();

    await waitUntil(() => !isProcessAlive(pid));
    await waitUntil(() => exits.length > 0);

    expect(exits).toEqual([{ terminalId: 1, exitCode: null }]);
  });

  it("closing 중 같은 terminalId의 open은 무시되고, exit 표면화 후에는 다시 열 수 있다", async () => {
    const { manager, exits } = makeManager();

    manager.open(1, 80, 24);
    manager.close(1);

    manager.open(1, 80, 24);
    expect(manager.pid(1)).toBeNull();

    await waitUntil(() => exits.length === 1);

    manager.open(1, 80, 24);
    expect(manager.pid(1)).not.toBeNull();
  });

  it("낮은 rate limit에서 종료 직전 출력이 onExit 보고 시점에 이미 모두 도착해 있다", async () => {
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    const textAtExit: string[] = [];
    const manager = new PtyManager(
      { clock: systemClock },
      {
        shell: "/bin/sh",
        rateLimitBytesPerSec: 2048,
        onOutput: (_id, chunk) => chunks.push(chunk),
        onExit: () => {
          textAtExit.push(chunks.map((c) => decoder.decode(c)).join(""));
        },
      },
    );
    managers.push(manager);

    manager.open(1, 80, 24);
    manager.write(1, encode("head -c 3000 /dev/zero | tr '\\0' a; echo END-\"MARK\"; exit 0\n"));

    await waitUntil(() => textAtExit.length > 0);
    const snapshot = textAtExit[0] ?? "";
    expect(snapshot).toContain("END-MARK");
    expect((snapshot.match(/a/g) ?? []).length).toBeGreaterThanOrEqual(3000);
  });

  it("이미 열린 terminalId로 open하면 무시되어 기존 셸이 유지된다", () => {
    const { manager } = makeManager();

    manager.open(1, 80, 24);
    const firstPid = manager.pid(1);

    manager.open(1, 120, 40);

    expect(manager.pid(1)).toBe(firstPid);
  });

  it("open·resize의 극단 크기는 clamp되어 셸이 계속 동작한다", async () => {
    const { manager, text } = makeManager();

    manager.open(1, 0, 1_000_000_000);
    expect(() => {
      manager.resize(1, 0, 0);
      manager.resize(1, 1_000_000_000, 1_000_000_000);
    }).not.toThrow();

    manager.write(1, encode("echo still-alive\n"));
    await waitUntil(() => text().includes("still-alive"));
  });

  it("멀티바이트 입력이 프레임 경계에서 쪼개져도 손상 없이 셸에 쓰인다", async () => {
    const { manager, text } = makeManager();

    manager.open(1, 80, 24);
    const command = encode("echo 안녕-마커\n");
    const splitInsideFirstKoreanCharacter = 7;
    manager.write(1, command.subarray(0, splitInsideFirstKoreanCharacter));
    manager.write(1, command.subarray(splitInsideFirstKoreanCharacter));

    await waitUntil(() => text().includes("안녕-마커"));
  });

  it("closeAll하면 모든 셸 프로세스가 종료되고 추적에서 제거된다", async () => {
    const { manager } = makeManager();

    manager.open(1, 80, 24);
    manager.open(2, 80, 24);
    const pids = [manager.pid(1), manager.pid(2)].filter((p): p is number => p !== null);
    expect(pids).toHaveLength(2);

    manager.closeAll();

    expect(manager.pid(1)).toBeNull();
    expect(manager.pid(2)).toBeNull();
    await waitUntil(() => pids.every((pid) => !isProcessAlive(pid)));
  });

  it("낮은 rate limit에서도 대량 출력이 드롭 없이 전부 도착한다", async () => {
    const { manager, text } = makeManager({ rateLimitBytesPerSec: 2048 });

    manager.open(1, 80, 24);
    manager.write(1, encode("head -c 3000 /dev/zero | tr '\\0' a; echo END-\"MARK\"\n"));

    await waitUntil(() => text().includes("END-MARK"));
    expect((text().match(/a/g) ?? []).length).toBeGreaterThanOrEqual(3000);
  });
});

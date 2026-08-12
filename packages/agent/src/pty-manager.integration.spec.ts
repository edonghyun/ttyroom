import { afterEach, describe, expect, it } from "vitest";
import { PtyManager } from "./pty-manager.js";
import { systemClock } from "./system-clock.js";
import { waitUntil } from "./test/wait-until.js";

/**
 * 상태×이벤트 전이표 (terminalId 단위) — 아래 테스트들이 각 칸을 핀한다.
 *
 * | 상태 \ 이벤트 | open           | write     | resize          | close           | PTY exit                |
 * |--------------|----------------|-----------|-----------------|-----------------|-------------------------|
 * | absent       | spawn → tracked| 무시      | 무시            | 무시            | —                       |
 * | tracked      | 무시(기존 유지)| pty.write | clamp 후 resize | kill → closing  | onExit(exitCode) 후 제거|
 * | closing      | 무시           | 무시      | 무시            | 무시            | onExit(null) 후 제거    |
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

    // closing 동안 외부 관점은 이미 닫힘 — 조작은 무시되고 조회는 null
    expect(manager.pid(1)).toBeNull();
    expect(manager.fgProcess(1)).toBeNull();
    expect(() => {
      manager.write(1, encode("echo ghost\n"));
      manager.close(1);
    }).not.toThrow();

    await waitUntil(() => !isProcessAlive(pid));
    await waitUntil(() => exits.length > 0);

    // 시그널 종료는 exitCode null — protocol의 int|null에서 null은 "정상 종료 코드 없음"
    expect(exits).toEqual([{ terminalId: 1, exitCode: null }]);
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
    // "echo " 5바이트 + '안' 3바이트 중 2바이트에서 절단 — 멀티바이트 문자가 두 프레임에 걸친다
    manager.write(1, command.subarray(0, 7));
    manager.write(1, command.subarray(7));

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
    // 2KiB/s로 조여도 3KB 출력이 결국 모두 도착 — 리미터가 경로에 있고 드롭이 없음을 함께 핀
    const { manager, text } = makeManager({ rateLimitBytesPerSec: 2048 });

    manager.open(1, 80, 24);
    // 마커를 따옴표로 쪼개 명령줄 에코가 조기 매치되지 않게 한다 — 출력에만 END-MARK가 온전히 나타난다
    manager.write(1, encode("head -c 3000 /dev/zero | tr '\\0' a; echo END-\"MARK\"\n"));

    await waitUntil(() => text().includes("END-MARK"));
    expect((text().match(/a/g) ?? []).length).toBeGreaterThanOrEqual(3000);
  });
});

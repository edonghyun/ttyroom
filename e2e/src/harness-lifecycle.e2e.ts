import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { given, waitUntil } from "./harness.js";
import { ServerProcess } from "@ttyroom/test-support/server-process";
import { TestProcess } from "@ttyroom/test-support/test-process";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

describe("E2E harness 수명 — 테스트 프로세스 정리", () => {
  it("시작 실패는 자식 프로세스의 종료 원인을 보여준다", async () => {
    await expect(
      ServerProcess.start(
        {},
        {
          command: [
            process.execPath,
            "-e",
            "console.error('startup-probe-failed'); process.exit(7)",
          ],
        },
      ),
    ).rejects.toThrow(/exit=7[\s\S]*startup-probe-failed/);
  });

  it("준비되지 않는 서버는 시작 제한시간 후 종료하며 프로세스를 남기지 않는다", async () => {
    const error = await ServerProcess.start(
      {},
      {
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        startupTimeoutMs: 500,
      },
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const pid = Number((error as Error).message.match(/pid=(\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("server close는 서버·Connector 자식 프로세스를 정리한다", async () => {
    await using probe = new TestProcess(
      [process.execPath, "--import", TSX_LOADER, "e2e/src/teardown-probe.ts"],
      WORKSPACE_ROOT,
      process.env,
    );

    await waitUntil(() => probe.exited(), {
      timeoutMs: 5_000,
      failure: () => probe.diagnostics(),
    });

    expect(probe.child.exitCode, probe.diagnostics()).toBe(0);
  });

  it("중첩 server에서도 room 소유 server가 자신이 만든 connector를 종료한다", async () => {
    await using serverA = await given.server();
    const roomA = await serverA.room();
    await using serverB = await given.server();
    const connectorA = await given.connector(roomA, "owned-by-a");

    await serverA.close();

    await expect.poll(() => connectorA.exited(), { timeout: 1_000 }).toBe(true);
  });

  it("정지된 connector가 있어도 server close는 제한 시간 안에 강제 종료한다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const connector = await given.connector(room, "stopped-connector");
    connector.kill("SIGSTOP");

    const close = server.close();
    const result = await Promise.race([
      close.then(() => "closed" as const),
      new Promise<"timeout">((resolveResult) => setTimeout(() => resolveResult("timeout"), 1_000)),
    ]);
    if (result === "timeout") {
      connector.kill("SIGCONT");
      connector.kill("SIGTERM");
      await close;
    }

    expect(result).toBe("closed");
    expect(connector.exited()).toBe(true);
  });
});

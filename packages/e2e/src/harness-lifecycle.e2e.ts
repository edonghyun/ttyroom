import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { given, waitUntil } from "./harness.js";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

describe("E2E harness 수명 — 테스트 프로세스 정리", () => {
  it("server close는 긴 유예 타이머를 남기지 않고 프로세스를 종료시킨다", async () => {
    const child = spawn(
      process.execPath,
      ["--import", TSX_LOADER, "packages/e2e/src/teardown-probe.ts"],
      { cwd: WORKSPACE_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const diagnostics: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString("utf8")));

    const result = await new Promise<{ kind: "exit"; code: number | null } | { kind: "timeout" }>(
      (resolveResult) => {
        const timeout = setTimeout(() => resolveResult({ kind: "timeout" }), 2_000);
        child.once("exit", (code) => {
          clearTimeout(timeout);
          resolveResult({ kind: "exit", code });
        });
      },
    );
    if (result.kind === "timeout") child.kill("SIGKILL");

    expect(result, diagnostics.join("")).toEqual({ kind: "exit", code: 0 });
  });

  it("중첩 server에서도 room 소유 server가 자신이 만든 agent를 종료한다", async () => {
    const serverA = await given.server();
    const roomA = await serverA.room();
    const serverB = await given.server();
    const agentA = await given.agent(roomA, "owned-by-a");

    await serverA.close();

    await waitUntil(() => agentA.exited(), { timeoutMs: 1_000 });
    await serverB.close();
  });

  it("정지된 agent가 있어도 server close는 제한 시간 안에 강제 종료한다", async () => {
    const server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "stopped-agent");
    agent.kill("SIGSTOP");

    const close = server.close();
    const result = await Promise.race([
      close.then(() => "closed" as const),
      new Promise<"timeout">((resolveResult) => setTimeout(() => resolveResult("timeout"), 1_000)),
    ]);
    if (result === "timeout") {
      agent.kill("SIGCONT");
      agent.kill("SIGTERM");
      await close;
    }

    expect(result).toBe("closed");
    expect(agent.exited()).toBe(true);
  });
});

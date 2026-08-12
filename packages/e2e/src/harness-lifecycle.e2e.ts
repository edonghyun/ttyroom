import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});

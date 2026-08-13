import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("@ttyroom/agent 패키지 — 역할: 실행 가능한 CLI 배포물", () => {
  it("workspace 설치는 루트에서 npx ttyroom 실행 파일을 제공한다", () => {
    const result = spawnSync("npm", ["exec", "--offline", "--", "ttyroom"], {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("사용법: ttyroom join <joinUrl>");
    expect(result.stderr).not.toContain("could not determine executable to run");
  });

  it("pack 결과는 빌드 산출물·설치 보조 스크립트·manifest만 포함한다", () => {
    const destination = mkdtempSync(path.join(tmpdir(), "ttyroom-agent-pack-"));
    try {
      execFileSync("pnpm", ["pack", "--pack-destination", destination], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: "0" },
      });
      const tarball = path.join(destination, readdirSync(destination)[0] ?? "missing.tgz");
      const paths = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((entry) => entry.replace(/^package\//, ""));

      expect(paths).toContain("dist/index.js");
      expect(paths.every((entry) => /^(dist\/|scripts\/|package\.json$)/.test(entry))).toBe(true);

      const manifest = execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
        encoding: "utf8",
      });
      expect(manifest).not.toContain("workspace:");
      expect(manifest).toContain('"ttyroom": "./dist/index.js"');
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

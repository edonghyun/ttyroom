import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");

describe("browser acceptance CI build contract", () => {
  it("builds every runtime artifact required by the browser health gate", async () => {
    const workflow = await readFile(resolve(WORKSPACE_ROOT, ".github/workflows/ci.yml"), "utf8");
    const browserJob = workflow.match(/\n  browser:\n([\s\S]*?)\n  full:/)?.[1] ?? "";

    expect(browserJob).toContain("pnpm --filter @ttyroom/web... build");
    expect(browserJob).toContain("bootJar -PwebDist=../web/dist");
    expect(browserJob).toContain("pnpm --filter @ttyroom/connector build");
    expect(browserJob).toContain("./scripts/test-spring.sh browser");
  });
});

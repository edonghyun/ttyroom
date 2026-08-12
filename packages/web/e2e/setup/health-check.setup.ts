import { expect } from "@playwright/test";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");

export default async function healthCheck(): Promise<void> {
  await expect
    .poll(async () => {
      try {
        await Promise.all([
          access(resolve(WORKSPACE_ROOT, "packages/server/dist/index.js")),
          access(resolve(WORKSPACE_ROOT, "packages/server/dist/web/index.html")),
          access(resolve(WORKSPACE_ROOT, "packages/agent/dist/index.js")),
        ]);
        return true;
      } catch {
        return false;
      }
    }, { message: "real server, web, and agent builds must exist before browser acceptance" })
    .toBe(true);
}

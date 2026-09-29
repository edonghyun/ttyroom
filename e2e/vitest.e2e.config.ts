import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    expect: { poll: { timeout: 10_000, interval: 10 } },
  },
});

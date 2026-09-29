import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/visual",
  testMatch: /.*\.e2e\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "test-results/visual",
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1487, height: 1058 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

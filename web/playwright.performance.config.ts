import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/performance",
  testMatch: /.*\.performance\.ts/,
  globalSetup: "./e2e/setup/health-check.setup.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  repeatEach: 3,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], trace: "off", screenshot: "off", video: "off" },
});

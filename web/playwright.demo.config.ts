import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./demo",
  testMatch: "*.demo.ts",
  timeout: 180_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: { actionTimeout: 10_000 },
  outputDir: "../artifacts/demo/test-results",
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/admission.spring.ts",
      "src/revocation.spring.ts",
      "src/inbound-limits.spring.ts",
      "src/global-limits.spring.ts",
      "src/credential-limits.spring.ts",
      "src/membership-limits.spring.ts",
      "src/stored-host-limits.spring.ts",
      "src/workspace-replay.spring.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

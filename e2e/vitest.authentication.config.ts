import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/admission.spring.ts",
      "src/revocation.spring.ts",
      "src/inbound-limits.spring.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

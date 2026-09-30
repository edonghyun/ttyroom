import { defineConfig } from "vitest/config";

// Registration is a Spring HTTP extension; the Node v7 reference does not implement it.
export default defineConfig({
  test: {
    include: ["src/registration.spring.ts", "src/http-contract.spring.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

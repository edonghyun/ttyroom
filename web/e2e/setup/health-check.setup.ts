import { access } from "node:fs/promises";
import { resolve } from "node:path";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");

export default async function healthCheck(): Promise<void> {
  const required = ["connector/dist/index.js"];
  if (!process.env.TTYROOM_E2E_SERVER_COMMAND) {
    throw new Error(
      "Browser acceptance requires Spring v8. Run ./scripts/test-spring.sh browser after ./scripts/build-spring.sh.",
    );
  }
  await Promise.all(required.map((path) => access(resolve(WORKSPACE_ROOT, path))));
  // The common process runner checks readiness; browser navigation verifies packaged web assets.
}

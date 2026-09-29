import { setTimeout as delay } from "node:timers/promises";

export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; failure?: () => string } = {},
): Promise<void> {
  const deadline = performance.now() + (options.timeoutMs ?? 10_000);
  while (!(await condition())) {
    if (performance.now() >= deadline) {
      throw new Error(options.failure?.() ?? "조건 대기 시간이 초과됐다");
    }
    // Poll for a semantic condition; avoid spinning the CPU with setImmediate.
    await delay(10);
  }
}

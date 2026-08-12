// 실제 인프라(PTY·프로세스) 테스트용 조건 폴링 — sleep 금지 규칙의 대안. e2e에서도 재사용한다.
export async function waitUntil(
  condition: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: ${timeoutMs}ms 안에 조건이 참이 되지 않았다`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

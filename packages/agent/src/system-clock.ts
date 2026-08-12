import type { AgentClock } from "./ports/agent-transport.js";

// 실제 타이머 어댑터 — 테스트는 FakeClock을 쓰고, 운영 배선만 이것을 쓴다
export const systemClock: AgentClock = {
  schedule(delayMs: number, fn: () => void): () => void {
    const timer = setTimeout(fn, delayMs);
    return () => clearTimeout(timer);
  },
};

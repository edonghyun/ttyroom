import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemClock } from "./system-clock.js";

describe("SystemClock — 역할: setTimeout 위임 Clock 어댑터", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("지연 경과 시 콜백을 실행하고, 취소하면 실행하지 않는다 (스모크)", () => {
    const clock = new SystemClock();
    const fired: string[] = [];

    clock.schedule(100, () => fired.push("a"));
    const cancel = clock.schedule(100, () => fired.push("b"));
    cancel();

    vi.advanceTimersByTime(150);
    expect(fired).toEqual(["a"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemClock } from "./system-clock.js";

describe("SystemClock — 역할: setTimeout 위임 Clock 어댑터", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("지연 경과 시 비동기 작업을 실행하고, 취소한 작업은 실행하지 않는다", async () => {
    const clock = new SystemClock();
    const fired: string[] = [];

    clock.schedule(100, async () => {
      await Promise.resolve();
      fired.push("a");
    });
    const cancel = clock.schedule(100, () => {
      fired.push("b");
    });
    cancel();

    await vi.advanceTimersByTimeAsync(150);
    expect(fired).toEqual(["a"]);
  });

  it("비동기 작업의 rejection을 오류 정책으로 전달한다", async () => {
    const errors: unknown[] = [];
    const clock = new SystemClock((error) => errors.push(error));
    const failure = new Error("timer failed");
    clock.schedule(100, async () => {
      throw failure;
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(errors).toEqual([failure]);
  });
});

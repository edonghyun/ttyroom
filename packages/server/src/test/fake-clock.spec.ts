import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake-clock.js";

describe("FakeClock — 역할: 시간을 감아서 타이머 로직을 결정론화", () => {
  it("advance가 경과 시각에 도달한 타이머만 실행한다", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.schedule(100, () => fired.push("a"));
    clock.schedule(200, () => fired.push("b"));
    clock.advance(150);
    expect(fired).toEqual(["a"]);
    clock.advance(50);
    expect(fired).toEqual(["a", "b"]);
  });

  it("취소한 타이머는 advance해도 실행되지 않는다", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    const cancel = clock.schedule(100, () => fired.push("a"));
    cancel();
    clock.advance(200);
    expect(fired).toEqual([]);
  });

  it("pendingCount는 아직 실행·취소되지 않은 타이머 수를 센다", () => {
    const clock = new FakeClock();
    const cancel = clock.schedule(100, () => {});
    clock.schedule(200, () => {});
    clock.schedule(300, () => {});
    expect(clock.pendingCount()).toBe(3);

    cancel();
    expect(clock.pendingCount()).toBe(2);

    clock.advance(250);
    expect(clock.pendingCount()).toBe(1);
  });
});

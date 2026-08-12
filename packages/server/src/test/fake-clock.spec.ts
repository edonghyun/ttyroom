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

  // 가드가 없으면 동기 무한 루프 — vitest 타임아웃도 못 끊고 스위트가 정지한다 (RED를 행으로 관찰함)
  it(
    "delay 0으로 자기 재등록하는 콜백은 무한 루프 대신 진단 에러로 끊는다",
    { timeout: 500 },
    () => {
      const clock = new FakeClock();
      const reschedule = (): void => {
        clock.schedule(0, reschedule);
      };
      clock.schedule(0, reschedule);

      expect(() => clock.advance(1)).toThrow(/한 advance에서 실행된 타이머가 상한/);
    },
  );

  it("등록 순서와 무관하게 due 시각 오름차순으로 발화한다", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.schedule(200, () => fired.push("late"));
    clock.schedule(100, () => fired.push("early"));
    clock.advance(250);
    expect(fired).toEqual(["early", "late"]);
  });

  it("콜백이 등록한 새 타이머도 advance 창 안이면 같은 advance에서 발화한다 (유예 체인)", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.schedule(100, () => {
      fired.push("first");
      clock.schedule(50, () => fired.push("chained")); // 발화 시각 t=100 기준 → t=150
    });
    clock.advance(200);
    expect(fired).toEqual(["first", "chained"]);
  });

  it("콜백이 등록한 타이머가 advance 창 밖이면 발화하지 않고 pending으로 남는다", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.schedule(100, () => {
      fired.push("first");
      clock.schedule(150, () => fired.push("beyond")); // t=250 — 창(200) 밖
    });
    clock.advance(200);
    expect(fired).toEqual(["first"]);
    expect(clock.pendingCount()).toBe(1);

    clock.advance(50);
    expect(fired).toEqual(["first", "beyond"]);
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

import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.js";
import { FakeClock } from "./test/fake-clock.js";

function makeLimiter(options: { bytesPerSec: number; burstBytes: number }) {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ clock }, options);
  const delivered: Uint8Array[] = [];
  const deliver = (chunk: Uint8Array) => delivered.push(chunk);
  return { clock, limiter, delivered, deliver };
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(chunks: Uint8Array[]): number[] {
  return chunks.flatMap((c) => [...c]);
}

describe("RateLimiter — 역할: 터미널별 출력 속도 상한", () => {
  it("버스트 한도 내 청크는 즉시 전달된다", () => {
    const { limiter, delivered, deliver } = makeLimiter({ bytesPerSec: 10, burstBytes: 10 });

    limiter.submit(bytes(1, 2, 3), deliver);

    expect(concat(delivered)).toEqual([1, 2, 3]);
  });

  it("한도 초과분은 시간이 지나야 순서대로 전달된다", () => {
    const { clock, limiter, delivered, deliver } = makeLimiter({ bytesPerSec: 10, burstBytes: 10 });
    const fifteen = bytes(...Array.from({ length: 15 }, (_, i) => i));

    limiter.submit(fifteen, deliver);
    const immediately = concat(delivered);
    clock.advance(500);
    const afterRefill = concat(delivered);

    expect(immediately).toEqual([...fifteen.subarray(0, 10)]);
    expect(afterRefill).toEqual([...fifteen]);
  });

  it("큰 초과 청크도 버스트 용량씩 나눠 속도 상한을 지킨다", () => {
    const { clock, limiter, delivered, deliver } = makeLimiter({ bytesPerSec: 10, burstBytes: 10 });
    const thirty = bytes(...Array.from({ length: 30 }, (_, i) => i));

    limiter.submit(thirty, deliver);
    const immediately = concat(delivered);
    clock.advance(1000);
    const afterFirstRefill = concat(delivered);
    clock.advance(1000);
    const afterSecondRefill = concat(delivered);

    expect(immediately).toEqual([...thirty.subarray(0, 10)]);
    expect(afterFirstRefill).toEqual([...thirty.subarray(0, 20)]);
    expect(afterSecondRefill).toEqual([...thirty]);
  });

  it("지연 큐가 있는 동안 새 submit은 큐를 앞지르지 않고 순서대로 전달된다", () => {
    const { clock, limiter, delivered, deliver } = makeLimiter({ bytesPerSec: 10, burstBytes: 10 });

    limiter.submit(bytes(...Array.from({ length: 15 }, () => 1)), deliver);
    limiter.submit(bytes(9, 9, 9), deliver);
    const immediately = concat(delivered);
    clock.advance(500);
    const beforeNewChunk = concat(delivered);
    clock.advance(300);
    const afterNewChunk = concat(delivered);

    expect(immediately).toHaveLength(10);
    expect(beforeNewChunk).toEqual([...Array.from({ length: 15 }, () => 1)]);
    expect(afterNewChunk).toEqual([...Array.from({ length: 15 }, () => 1), 9, 9, 9]);
  });

  it("flush는 지연 큐의 잔여를 순서대로 즉시 비우고 예약 타이머를 해제한다", () => {
    const { clock, limiter, delivered, deliver } = makeLimiter({ bytesPerSec: 10, burstBytes: 10 });
    const fifteen = bytes(...Array.from({ length: 15 }, (_, i) => i));

    limiter.submit(fifteen, deliver);
    const beforeFlush = concat(delivered);
    limiter.flush();
    const flushed = concat(delivered);
    const pendingTimers = clock.pendingTimerCount();
    clock.advance(10_000);
    const afterTimers = concat(delivered);

    expect(beforeFlush).toHaveLength(10);
    expect(flushed).toEqual([...fifteen]);
    expect(pendingTimers).toBe(0);
    expect(afterTimers).toEqual([...fifteen]);
  });

  it("큐가 빈 뒤 충분히 유휴하면 버스트 용량이 회복된다", () => {
    const { clock, limiter, delivered, deliver } = makeLimiter({ bytesPerSec: 10, burstBytes: 10 });

    limiter.submit(bytes(...Array.from({ length: 10 }, () => 7)), deliver);
    const beforeIdle = concat(delivered);
    clock.advance(1000);
    limiter.submit(bytes(...Array.from({ length: 10 }, () => 8)), deliver);

    expect(beforeIdle).toHaveLength(10);
    expect(concat(delivered)).toHaveLength(20);
  });
});

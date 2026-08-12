import type { CancelTimer, Clock } from "../ports/clock.js";

// 유예 체인(단절→유예→해제 등)은 깊이가 한 자릿수다 — 10_000이면 정상 시나리오와
// 자기 재등록 폭주를 확실히 가른다. 초과는 테스트 대상 코드의 버그로 보고 진단 throw.
const MAX_FIRED_PER_ADVANCE = 10_000;

interface PendingTimer {
  at: number;
  fn: () => void;
  cancelled: boolean;
  fired: boolean;
}

export class FakeClock implements Clock {
  private readonly timers: PendingTimer[] = [];
  private now = 0;

  schedule(delayMs: number, fn: () => void): CancelTimer {
    const timer: PendingTimer = { at: this.now + delayMs, fn, cancelled: false, fired: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  advance(ms: number): void {
    this.now += ms;

    // 콜백이 새 타이머를 등록해도(유예 체인) 경과분은 같은 advance에서 소화한다
    let firedCount = 0;
    let next = this.nextDueTimer();
    while (next) {
      firedCount += 1;
      if (firedCount > MAX_FIRED_PER_ADVANCE) {
        // 동기 무한 루프는 vitest 타임아웃도 못 끊는다 — 여기서 진단하고 크게 실패시킨다
        throw new Error(
          `한 advance에서 실행된 타이머가 상한(${MAX_FIRED_PER_ADVANCE})을 넘었다 — ` +
            "콜백이 delay 0으로 자기 자신을 재등록하고 있는지 확인하라",
        );
      }

      next.fired = true;
      next.fn();
      next = this.nextDueTimer();
    }
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled && !t.fired).length;
  }

  private nextDueTimer(): PendingTimer | undefined {
    // 등록 순서 실행 계약 — 정렬 대신 삽입 순서 순회
    return this.timers.find((t) => !t.cancelled && !t.fired && t.at <= this.now);
  }
}

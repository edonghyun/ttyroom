import type { CancelTimer, Clock } from "../ports/clock.js";

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
    let next = this.nextDueTimer();
    while (next) {
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

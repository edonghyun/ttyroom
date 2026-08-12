import type { AgentClock } from "../ports/agent-transport.js";

interface ScheduledTimer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

export class FakeClock implements AgentClock {
  private now = 0;
  private timers: ScheduledTimer[] = [];

  schedule(delayMs: number, fn: () => void): () => void {
    const timer: ScheduledTimer = { at: this.now + delayMs, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  advance(ms: number): void {
    const target = this.now + ms;

    // 발화가 새 타이머를 예약할 수 있으므로 매번 만기 타이머를 다시 찾는다
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;

      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }

    this.now = target;
  }

  pendingTimerCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

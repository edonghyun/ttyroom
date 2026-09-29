import type { ConnectorClock } from "../ports/connector-transport.js";

interface ScheduledTimer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

export class FakeClock implements ConnectorClock {
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

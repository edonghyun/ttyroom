import type { CancelTimer, Clock } from "../../ports/clock.js";

export class SystemClock implements Clock {
  schedule(delayMs: number, fn: () => void): CancelTimer {
    const handle = setTimeout(fn, delayMs);
    return () => clearTimeout(handle);
  }
}

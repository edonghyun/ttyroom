import type { CancelTimer, Clock, TimerTask } from "../../ports/clock.js";

export class SystemClock implements Clock {
  constructor(private readonly onError: (error: unknown) => void = () => undefined) {}

  schedule(delayMs: number, task: TimerTask): CancelTimer {
    const handle = setTimeout(() => {
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => this.onError(error));
    }, delayMs);
    return () => clearTimeout(handle);
  }
}

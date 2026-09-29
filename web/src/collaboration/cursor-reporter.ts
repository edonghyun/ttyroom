import type { CursorPosition } from "./participant-cursor-motion.js";

export interface CursorReporterScheduler {
  now(): number;
  requestFrame(callback: () => void): () => void;
}

export interface CursorReporterOptions {
  readonly scheduler?: CursorReporterScheduler;
  readonly reportsPerSecond?: number;
}

const DEFAULT_REPORTS_PER_SECOND = 30;

export class CursorReporter {
  private pending: CursorPosition | undefined;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private cancelFrame: (() => void) | null = null;
  private disposed = false;
  private readonly scheduler: CursorReporterScheduler;
  private readonly intervalMs: number;

  constructor(
    private readonly send: (position: CursorPosition | null) => void,
    options: CursorReporterOptions = {},
  ) {
    this.scheduler = options.scheduler ?? browserCursorReporterScheduler;
    this.intervalMs = 1_000 / (options.reportsPerSecond ?? DEFAULT_REPORTS_PER_SECOND);
  }

  move(position: CursorPosition | null): void {
    if (this.disposed) return;
    if (position === null) {
      this.pending = undefined;
      this.cancelFrame?.();
      this.cancelFrame = null;
      this.lastSentAt = this.scheduler.now();
      this.send(null);
      return;
    }

    this.pending = { ...position };
    if (this.scheduler.now() - this.lastSentAt >= this.intervalMs) this.flush();
    else this.ensureFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = undefined;
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  private readonly onFrame = (): void => {
    this.cancelFrame = null;
    if (this.disposed || this.pending === undefined) return;
    if (this.scheduler.now() - this.lastSentAt >= this.intervalMs) this.flush();
    else this.ensureFrame();
  };

  private flush(): void {
    const position = this.pending;
    if (!position) return;
    this.pending = undefined;
    this.lastSentAt = this.scheduler.now();
    this.send(position);
  }

  private ensureFrame(): void {
    if (!this.cancelFrame) this.cancelFrame = this.scheduler.requestFrame(this.onFrame);
  }
}

const browserCursorReporterScheduler: CursorReporterScheduler = {
  now: () => performance.now(),
  requestFrame: (callback) => {
    const frame = globalThis.requestAnimationFrame(callback);
    return () => globalThis.cancelAnimationFrame(frame);
  },
};

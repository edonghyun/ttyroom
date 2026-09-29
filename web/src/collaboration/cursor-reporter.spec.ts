import { describe, expect, it, vi } from "vitest";

import { CursorReporter, type CursorReporterScheduler } from "./cursor-reporter.js";

describe("CursorReporter", () => {
  it("sends at most 30 times per second while retaining the newest pending point", () => {
    const scheduler = new ManualFrameScheduler();
    const send = vi.fn();
    const reporter = new CursorReporter(send, { scheduler });

    reporter.move({ x: 0, y: 0 });
    scheduler.at(10);
    reporter.move({ x: 10, y: 5 });
    scheduler.at(20);
    reporter.move({ x: 20, y: 10 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingFrames()).toBe(1);

    scheduler.at(34).renderFrame();
    expect(send).toHaveBeenNthCalledWith(2, { x: 20, y: 10 });

    scheduler.at(40);
    reporter.move({ x: 40, y: 20 });
    scheduler.at(68).renderFrame();
    expect(send).toHaveBeenNthCalledWith(3, { x: 40, y: 20 });
    reporter.dispose();
  });

  it("publishes leave immediately and cancels an obsolete pending point", () => {
    const scheduler = new ManualFrameScheduler();
    const send = vi.fn();
    const reporter = new CursorReporter(send, { scheduler });

    reporter.move({ x: 0, y: 0 });
    scheduler.at(10);
    reporter.move({ x: 100, y: 50 });
    reporter.move(null);

    expect(send).toHaveBeenNthCalledWith(2, null);
    expect(scheduler.pendingFrames()).toBe(0);
    scheduler.at(100).renderFrame();
    expect(send).toHaveBeenCalledTimes(2);
    reporter.dispose();
  });
});

class ManualFrameScheduler implements CursorReporterScheduler {
  private time = 0;
  private nextId = 0;
  private readonly frames = new Map<number, () => void>();

  now(): number {
    return this.time;
  }

  requestFrame(callback: () => void): () => void {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return () => this.frames.delete(id);
  }

  at(time: number): this {
    this.time = time;
    return this;
  }

  renderFrame(): void {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback();
  }

  pendingFrames(): number {
    return this.frames.size;
  }
}

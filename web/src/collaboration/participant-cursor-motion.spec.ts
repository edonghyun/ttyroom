import { describe, expect, it, vi } from "vitest";

import {
  ParticipantCursorMotion,
  type ParticipantCursorMotionScheduler,
} from "./participant-cursor-motion.js";

describe("ParticipantCursorMotion", () => {
  it("interpolates sparse network samples on animation frames and settles on the latest point", () => {
    const scheduler = new ManualMotionScheduler();
    const motion = new ParticipantCursorMotion({ scheduler });
    const changed = vi.fn();
    motion.subscribe(changed);

    motion.receive({ clientId: "bob", name: "Bob", position: { x: 0, y: 0 } });
    scheduler.at(16).renderFrame();
    expect(motion.snapshot()).toEqual([{ clientId: "bob", name: "Bob", position: { x: 0, y: 0 } }]);

    scheduler.at(40);
    motion.receive({ clientId: "bob", name: "Bob", position: { x: 120, y: 60 } });
    scheduler.at(64).renderFrame();
    expect(motion.snapshot()[0]?.position).toEqual({ x: 12, y: 6 });

    scheduler.at(80).renderFrame();
    expect(motion.snapshot()[0]?.position).toEqual({ x: 60, y: 30 });

    scheduler.at(100).renderFrame();
    expect(motion.snapshot()[0]?.position).toEqual({ x: 120, y: 60 });
    expect(changed).toHaveBeenCalledTimes(4);
    motion.dispose();
  });

  it("removes cursors immediately on leave and after the last sample becomes stale", () => {
    const scheduler = new ManualMotionScheduler();
    const motion = new ParticipantCursorMotion({ scheduler });

    motion.receive({ clientId: "bob", name: "Bob", position: { x: 40, y: 20 } });
    scheduler.at(16).renderFrame();
    motion.receive({ clientId: "bob", name: "Bob", position: null });
    expect(motion.snapshot()).toEqual([]);

    scheduler.at(100);
    motion.receive({ clientId: "alice", name: "Alice", position: { x: 80, y: 50 } });
    scheduler.at(116).renderFrame();
    expect(motion.snapshot()).toHaveLength(1);
    scheduler.at(2_100).runDueTimers();
    expect(motion.snapshot()).toEqual([]);
    motion.dispose();
  });

  it("cancels animation and expiry work when disposed", () => {
    const scheduler = new ManualMotionScheduler();
    const motion = new ParticipantCursorMotion({ scheduler });

    motion.receive({ clientId: "bob", name: "Bob", position: { x: 10, y: 20 } });
    motion.dispose();

    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
    motion.receive({ clientId: "alice", name: "Alice", position: { x: 1, y: 2 } });
    expect(motion.snapshot()).toEqual([]);
  });
});

class ManualMotionScheduler implements ParticipantCursorMotionScheduler {
  private time = 0;
  private nextId = 0;
  private readonly frames = new Map<number, () => void>();
  private readonly timers = new Map<
    number,
    { readonly dueAt: number; readonly callback: () => void }
  >();

  now(): number {
    return this.time;
  }

  requestFrame(callback: () => void): () => void {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return () => this.frames.delete(id);
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.time + delayMs, callback });
    return () => this.timers.delete(id);
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

  runDueTimers(): void {
    for (const [id, timer] of [...this.timers]) {
      if (timer.dueAt > this.time) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }

  pendingFrames(): number {
    return this.frames.size;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}

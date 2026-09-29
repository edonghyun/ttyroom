export interface CursorPosition {
  readonly x: number;
  readonly y: number;
}

export interface ParticipantCursorFrame {
  readonly clientId: string;
  readonly name: string;
  readonly position: CursorPosition;
}

export interface ParticipantCursorMotionSource {
  readonly subscribe: (subscriber: () => void) => () => void;
  readonly snapshot: () => readonly ParticipantCursorFrame[];
}

export interface ParticipantCursorMotionPort extends ParticipantCursorMotionSource {
  receive(cursor: {
    readonly clientId: string;
    readonly name: string;
    readonly position: CursorPosition | null;
  }): void;
  dispose(): void;
}

export interface ParticipantCursorMotionScheduler {
  now(): number;
  requestFrame(callback: () => void): () => void;
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface ParticipantCursorMotionOptions {
  readonly scheduler?: ParticipantCursorMotionScheduler;
  readonly interpolationDelayMs?: number;
  readonly staleAfterMs?: number;
}

interface CursorSample {
  readonly at: number;
  readonly position: CursorPosition;
}

interface CursorTrack {
  readonly clientId: string;
  name: string;
  samples: CursorSample[];
  cancelExpiry: () => void;
}

const INTERPOLATION_DELAY_MS = 60;
const CURSOR_STALE_AFTER_MS = 2_000;
const MAX_BUFFERED_SAMPLES = 8;

export class ParticipantCursorMotion implements ParticipantCursorMotionPort {
  private readonly tracks = new Map<string, CursorTrack>();
  private readonly subscribers = new Set<() => void>();
  private currentSnapshot: readonly ParticipantCursorFrame[] = [];
  private cancelFrame: (() => void) | null = null;
  private disposed = false;
  private readonly scheduler: ParticipantCursorMotionScheduler;
  private readonly interpolationDelayMs: number;
  private readonly staleAfterMs: number;

  constructor(options: ParticipantCursorMotionOptions = {}) {
    this.scheduler = options.scheduler ?? browserMotionScheduler;
    this.interpolationDelayMs = options.interpolationDelayMs ?? INTERPOLATION_DELAY_MS;
    this.staleAfterMs = options.staleAfterMs ?? CURSOR_STALE_AFTER_MS;
  }

  readonly subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  };

  readonly snapshot = (): readonly ParticipantCursorFrame[] => this.currentSnapshot;

  receive(cursor: {
    readonly clientId: string;
    readonly name: string;
    readonly position: CursorPosition | null;
  }): void {
    if (this.disposed) return;
    if (cursor.position === null) {
      this.remove(cursor.clientId);
      return;
    }

    const at = this.scheduler.now();
    const existing = this.tracks.get(cursor.clientId);
    const sample = { at, position: { ...cursor.position } };
    if (existing) {
      existing.name = cursor.name;
      existing.cancelExpiry();
      const lastSample = existing.samples.at(-1);
      if (lastSample?.at === at) existing.samples[existing.samples.length - 1] = sample;
      else existing.samples.push(sample);
      if (existing.samples.length > MAX_BUFFERED_SAMPLES) {
        existing.samples.splice(0, existing.samples.length - MAX_BUFFERED_SAMPLES);
      }
      existing.cancelExpiry = this.expireLater(cursor.clientId);
    } else {
      this.tracks.set(cursor.clientId, {
        clientId: cursor.clientId,
        name: cursor.name,
        samples: [sample],
        cancelExpiry: this.expireLater(cursor.clientId),
      });
    }
    this.ensureFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFrame?.();
    this.cancelFrame = null;
    for (const track of this.tracks.values()) track.cancelExpiry();
    this.tracks.clear();
    this.subscribers.clear();
    this.currentSnapshot = [];
  }

  private readonly renderFrame = (): void => {
    this.cancelFrame = null;
    if (this.disposed) return;

    const renderAt = this.scheduler.now() - this.interpolationDelayMs;
    const nextSnapshot: ParticipantCursorFrame[] = [];
    let interpolationPending = false;
    for (const track of this.tracks.values()) {
      nextSnapshot.push({
        clientId: track.clientId,
        name: track.name,
        position: positionAt(track.samples, renderAt),
      });
      while (track.samples.length > 2 && track.samples[1]!.at <= renderAt) {
        track.samples.shift();
      }
      if (
        track.samples.length > 1 &&
        (track.samples.at(-1)?.at ?? Number.NEGATIVE_INFINITY) > renderAt
      ) {
        interpolationPending = true;
      } else if (track.samples.length > 1) {
        track.samples = [track.samples.at(-1)!];
      }
    }

    if (!sameSnapshot(this.currentSnapshot, nextSnapshot)) {
      this.currentSnapshot = nextSnapshot;
      for (const subscriber of this.subscribers) subscriber();
    }
    if (interpolationPending) this.ensureFrame();
  };

  private ensureFrame(): void {
    if (!this.cancelFrame) this.cancelFrame = this.scheduler.requestFrame(this.renderFrame);
  }

  private expireLater(clientId: string): () => void {
    return this.scheduler.schedule(this.staleAfterMs, () => this.remove(clientId));
  }

  private remove(clientId: string): void {
    const track = this.tracks.get(clientId);
    if (!track) return;
    track.cancelExpiry();
    this.tracks.delete(clientId);
    const nextSnapshot = this.currentSnapshot.filter((cursor) => cursor.clientId !== clientId);
    if (nextSnapshot.length === this.currentSnapshot.length) return;
    this.currentSnapshot = nextSnapshot;
    for (const subscriber of this.subscribers) subscriber();
  }
}

function positionAt(samples: readonly CursorSample[], at: number): CursorPosition {
  const first = samples[0];
  if (!first) return { x: 0, y: 0 };
  if (at <= first.at) return first.position;

  for (let index = 1; index < samples.length; index += 1) {
    const next = samples[index]!;
    if (at > next.at) continue;
    const previous = samples[index - 1]!;
    const duration = next.at - previous.at;
    if (duration <= 0) return next.position;
    const progress = Math.min(1, Math.max(0, (at - previous.at) / duration));
    return {
      x: previous.position.x + (next.position.x - previous.position.x) * progress,
      y: previous.position.y + (next.position.y - previous.position.y) * progress,
    };
  }
  return samples.at(-1)!.position;
}

function sameSnapshot(
  left: readonly ParticipantCursorFrame[],
  right: readonly ParticipantCursorFrame[],
): boolean {
  return (
    left.length === right.length &&
    left.every((cursor, index) => {
      const candidate = right[index];
      return (
        candidate?.clientId === cursor.clientId &&
        candidate.name === cursor.name &&
        candidate.position.x === cursor.position.x &&
        candidate.position.y === cursor.position.y
      );
    })
  );
}

const browserMotionScheduler: ParticipantCursorMotionScheduler = {
  now: () => performance.now(),
  requestFrame: (callback) => {
    const frame = globalThis.requestAnimationFrame(callback);
    return () => globalThis.cancelAnimationFrame(frame);
  },
  schedule: (delayMs, callback) => {
    const timer = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(timer);
  },
};

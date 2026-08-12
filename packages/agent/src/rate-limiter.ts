import type { AgentClock } from "./ports/agent-transport.js";

interface RateLimiterDeps {
  clock: AgentClock;
}

interface RateLimiterOptions {
  bytesPerSec: number;
  burstBytes: number;
}

interface QueuedChunk {
  chunk: Uint8Array;
  deliver: (chunk: Uint8Array) => void;
}

// 토큰 버킷 — 한 터미널의 폭주가 연결 전체를 점유하지 못하게 (스펙 백프레셔). 드롭 없음.
export class RateLimiter {
  private tokens: number;
  private readonly queue: QueuedChunk[] = [];
  private drainScheduled = false;
  private cancelRefill: (() => void) | null = null;

  constructor(
    private readonly deps: RateLimiterDeps,
    private readonly options: RateLimiterOptions,
  ) {
    this.tokens = options.burstBytes;
  }

  submit(chunk: Uint8Array, deliver: (chunk: Uint8Array) => void): void {
    if (chunk.length === 0) return;

    // 진행 중인 유휴 회복은 취소 — 부분 축적은 포기한다 (AgentClock에 now가 없어
    // 경과를 알 수 없다. 상한만 보장하는 보수적 선택)
    this.cancelRefill?.();
    this.cancelRefill = null;

    this.queue.push({ chunk, deliver });
    this.drain();
  }

  // 토큰이 허락하는 만큼 큐 앞에서부터 전달하고, 남으면 다음 축적 시점을 예약한다
  private drain(): void {
    while (this.queue.length > 0 && this.tokens > 0) {
      const front = this.queue[0];
      if (!front) break;

      if (front.chunk.length <= this.tokens) {
        this.tokens -= front.chunk.length;
        this.queue.shift();
        front.deliver(front.chunk);
        continue;
      }

      const part = front.chunk.subarray(0, this.tokens);
      front.chunk = front.chunk.subarray(this.tokens);
      this.tokens = 0;
      front.deliver(part);
    }

    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.queue.length === 0) {
      this.scheduleRefill();
      return;
    }
    if (this.drainScheduled) return;

    const front = this.queue[0];
    if (!front) return;

    // 큐 앞 청크 전체가 축적되는 시점에 깨어난다 — ceil이라 크레딧은 필요량 이하(보수적)
    const delayMs = Math.ceil((front.chunk.length / this.options.bytesPerSec) * 1000);
    const accruedBytes = front.chunk.length;

    this.drainScheduled = true;
    this.deps.clock.schedule(delayMs, () => {
      this.drainScheduled = false;
      this.tokens += accruedBytes;
      this.drain();
    });
  }

  // 큐가 빈 뒤 버킷이 다시 차는 시점을 예약한다 — 유휴가 지속되면 버스트 용량 회복
  private scheduleRefill(): void {
    if (this.cancelRefill || this.tokens >= this.options.burstBytes) return;

    const missingBytes = this.options.burstBytes - this.tokens;
    const delayMs = Math.ceil((missingBytes / this.options.bytesPerSec) * 1000);

    this.cancelRefill = this.deps.clock.schedule(delayMs, () => {
      this.cancelRefill = null;
      this.tokens = this.options.burstBytes;
    });
  }
}

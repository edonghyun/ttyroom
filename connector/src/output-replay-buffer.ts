import type { OutputFrame } from "@ttyroom/protocol";

export class OutputReplayBuffer {
  private readonly stored: OutputFrame[] = [];
  private byteCount = 0;
  private lastOutputSeq = 0;

  constructor(private readonly options: { maxBytes: number }) {}

  append(frame: OutputFrame): void {
    const copy = copyFrame(frame);
    this.stored.push(copy);
    this.byteCount += copy.payload.byteLength;
    this.lastOutputSeq = Math.max(this.lastOutputSeq, copy.seq);
    while (this.byteCount > this.options.maxBytes) {
      const removed = this.stored.shift();
      if (!removed) break;
      this.byteCount -= removed.payload.byteLength;
    }
  }

  inventory(): { firstRetainedSeq: number; lastOutputSeq: number } {
    return {
      firstRetainedSeq: this.stored[0]?.seq ?? this.lastOutputSeq,
      lastOutputSeq: this.lastOutputSeq,
    };
  }

  framesAfter(seq: number): OutputFrame[] {
    return this.stored.filter((frame) => frame.seq > seq).map(copyFrame);
  }
}

function copyFrame(frame: OutputFrame): OutputFrame {
  return { ...frame, payload: frame.payload.slice() };
}

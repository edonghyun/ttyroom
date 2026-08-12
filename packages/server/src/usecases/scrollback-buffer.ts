import type { OutputFrame } from "@ttyroom/protocol";

export class ScrollbackBuffer {
  private readonly stored: OutputFrame[] = [];
  private byteCount = 0;

  constructor(private readonly options: { maxBytes: number }) {}

  append(frame: OutputFrame): void {
    this.stored.push(copyFrame(frame));
    this.byteCount += frame.payload.byteLength;
    while (this.byteCount > this.options.maxBytes) {
      const removed = this.stored.shift();
      if (!removed) break;
      this.byteCount -= removed.payload.byteLength;
    }
  }

  frames(): OutputFrame[] {
    return this.stored.map(copyFrame);
  }

  totalBytes(): number {
    return this.byteCount;
  }

  lastSeq(): number {
    return this.stored[this.stored.length - 1]?.seq ?? 0;
  }
}

function copyFrame(frame: OutputFrame): OutputFrame {
  return { ...frame, payload: frame.payload.slice() };
}

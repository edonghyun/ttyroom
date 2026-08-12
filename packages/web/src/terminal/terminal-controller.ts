import type {
  FrameScheduler,
  TerminalAdapter,
  TerminalAdapterFactory,
  TerminalGridSize,
} from "./terminal-adapter.js";

export class TerminalController {
  private adapter: TerminalAdapter | null = null;
  private readonly pendingOutput = new Map<
    number,
    { readonly seq: number; readonly bytes: Uint8Array; readonly replace: boolean }
  >();
  private cancelFrame: (() => void) | null = null;
  private highestSeq = 0;
  private inputAllowed = false;
  private unsubscribeInput: (() => void) | null = null;
  private fitPending = false;
  private lastGridSize: TerminalGridSize | null = null;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly deps: {
      readonly adapterFactory: TerminalAdapterFactory;
      readonly frameScheduler: FrameScheduler;
    },
    private readonly options: {
      readonly terminalId: number;
      readonly sendInput: (bytes: Uint8Array) => void;
      readonly resize: (size: TerminalGridSize) => void;
    },
  ) {}

  mount(container: HTMLElement): void {
    if (this.adapter || this.disposed) return;
    this.adapter = this.deps.adapterFactory.create();
    this.adapter.mount(container);
    this.adapter.setInputEnabled(this.inputAllowed);
    this.unsubscribeInput = this.adapter.subscribeInput((input) => {
      if (this.inputAllowed && input.key !== "Tab") this.options.sendInput(input.bytes.slice());
    });
    this.scheduleFrame();
  }

  setInputAllowed(allowed: boolean): void {
    if (this.disposed) return;
    this.inputAllowed = allowed;
    this.adapter?.setInputEnabled(allowed);
  }

  requestFit(): void {
    if (this.disposed) return;
    this.fitPending = true;
    this.scheduleFrame();
  }

  setVisible(visible: boolean): void {
    if (visible) this.requestFit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.unsubscribeInput?.();
    this.unsubscribeInput = null;
    this.adapter?.dispose();
    this.pendingOutput.clear();
  }

  acceptOutput(frame: {
    readonly seq: number;
    readonly bytes: Uint8Array;
    readonly replace: boolean;
  }): void {
    if (this.disposed) return;
    if (frame.replace) this.pendingOutput.clear();
    if (this.pendingOutput.has(frame.seq)) return;

    this.pendingOutput.set(frame.seq, { ...frame, bytes: frame.bytes.slice() });
    this.highestSeq = frame.replace ? frame.seq : Math.max(this.highestSeq, frame.seq);
    this.scheduleFrame();
  }

  lastSeq(): number {
    return this.highestSeq;
  }

  private scheduleFrame(): void {
    if (!this.adapter || this.cancelFrame || (this.pendingOutput.size === 0 && !this.fitPending))
      return;
    const generation = this.generation;
    this.cancelFrame = this.deps.frameScheduler.schedule(() => {
      this.cancelFrame = null;
      if (this.disposed || generation !== this.generation) return;
      this.flushOutput();
      this.flushFit();
    });
  }

  private flushOutput(): void {
    const adapter = this.adapter;
    if (!adapter) return;

    const frames = [...this.pendingOutput.values()].sort((left, right) => left.seq - right.seq);
    this.pendingOutput.clear();
    for (const frame of frames) {
      if (frame.replace) adapter.reset();
      adapter.write(frame.bytes);
    }
  }

  private flushFit(): void {
    if (!this.adapter || !this.fitPending) return;
    this.fitPending = false;
    const next = this.adapter.fit();
    if (this.lastGridSize?.cols === next.cols && this.lastGridSize.rows === next.rows) return;
    this.lastGridSize = next;
    this.options.resize(next);
  }
}

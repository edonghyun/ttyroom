import type {
  TerminalAdapter,
  TerminalAdapterFactory,
  TerminalGridSize,
  TerminalInput,
} from "../terminal/terminal-adapter.js";

export class FakeTerminalAdapter implements TerminalAdapter {
  mountedIn: HTMLElement | null = null;
  readonly writes: Uint8Array[] = [];
  resetCount = 0;
  fitCount = 0;
  focusCount = 0;
  disposeCount = 0;
  inputEnabled = false;
  grid: TerminalGridSize = { cols: 80, rows: 24 };
  private readonly inputSubscribers = new Set<(input: TerminalInput) => void>();

  mount(container: HTMLElement): void {
    this.mountedIn = container;
  }

  write(bytes: Uint8Array): void {
    this.writes.push(bytes.slice());
  }

  reset(): void {
    this.resetCount += 1;
  }

  fit(): TerminalGridSize {
    this.fitCount += 1;
    return this.grid;
  }

  focus(): void {
    this.focusCount += 1;
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
  }

  subscribeInput(subscriber: (input: TerminalInput) => void): () => void {
    this.inputSubscribers.add(subscriber);
    return () => this.inputSubscribers.delete(subscriber);
  }

  input(input: TerminalInput): void {
    for (const subscriber of this.inputSubscribers) subscriber(input);
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

export class FakeTerminalAdapterFactory implements TerminalAdapterFactory {
  readonly created: FakeTerminalAdapter[] = [];

  create(): FakeTerminalAdapter {
    const adapter = new FakeTerminalAdapter();
    this.created.push(adapter);
    return adapter;
  }
}

export interface TerminalInput {
  readonly bytes: Uint8Array;
  readonly key?: string;
}

export interface TerminalGridSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalAdapter {
  mount(container: HTMLElement): void;
  write(bytes: Uint8Array): void;
  reset(): void;
  fit(): TerminalGridSize;
  focus(): void;
  setInputEnabled(enabled: boolean): void;
  subscribeInput(subscriber: (input: TerminalInput) => void): () => void;
  dispose(): void;
}

export interface TerminalAdapterFactory {
  create(): TerminalAdapter;
}

export interface FrameScheduler {
  schedule(callback: () => void): () => void;
}

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type { TerminalAdapter, TerminalInput } from "./terminal-adapter.js";

export interface XtermFactory {
  createTerminal(): Terminal;
  createFitAddon(): FitAddon;
}

const nativeXtermFactory: XtermFactory = {
  createTerminal: () => new Terminal({ convertEol: true, disableStdin: true }),
  createFitAddon: () => new FitAddon(),
};

export class XtermAdapter implements TerminalAdapter {
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly inputSubscribers = new Set<(input: TerminalInput) => void>();
  private readonly inputDisposable: { dispose(): void };
  private mounted = false;
  private disposed = false;
  private inputEnabled = false;

  constructor(factory: XtermFactory = nativeXtermFactory) {
    this.terminal = factory.createTerminal();
    this.terminal.options.fontFamily = '"Fira Code Variable", monospace';
    this.terminal.options.fontSize = 12;
    this.terminal.options.lineHeight = 1.25;
    this.terminal.options.theme = {
      background: "#111417",
      foreground: "#d7dbe0",
      cursor: "#d7dbe0",
      selectionBackground: "#564070",
    };
    this.fitAddon = factory.createFitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.attachCustomKeyEventHandler(
      (event) =>
        event.key !== "Tab" && event.key !== "Escape" && !(event.altKey && event.key === "o"),
    );
    this.inputDisposable = this.terminal.onData((data) => {
      if (!this.inputEnabled) return;
      const input = { bytes: new TextEncoder().encode(data) };
      for (const subscriber of this.inputSubscribers) subscriber(input);
    });
  }

  mount(container: HTMLElement): void {
    if (this.mounted || this.disposed) return;
    this.mounted = true;
    this.terminal.open(container);
  }

  write(bytes: Uint8Array): void {
    if (!this.disposed) this.terminal.write(bytes);
  }

  reset(): void {
    if (!this.disposed) this.terminal.reset();
  }

  fit(): { cols: number; rows: number } {
    if (!this.disposed) this.fitAddon.fit();
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  focus(): void {
    if (!this.disposed) this.terminal.focus();
  }

  setInputEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.inputEnabled = enabled;
    this.terminal.options.disableStdin = !enabled;
  }

  subscribeInput(subscriber: (input: TerminalInput) => void): () => void {
    this.inputSubscribers.add(subscriber);
    return () => this.inputSubscribers.delete(subscriber);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inputDisposable.dispose();
    this.inputSubscribers.clear();
    this.terminal.dispose();
  }
}

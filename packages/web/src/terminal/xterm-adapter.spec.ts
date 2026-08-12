import { describe, expect, it, vi } from "vitest";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { XtermAdapter, type XtermFactory } from "./xterm-adapter.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

class FakeTerminal {
  readonly options: Record<string, unknown> = { disableStdin: false };
  cols = 80;
  rows = 24;
  loadedAddons: unknown[] = [];
  openedIn: HTMLElement | null = null;
  writes: Uint8Array[] = [];
  resetCount = 0;
  focusCount = 0;
  disposeCount = 0;
  onDataHandler: ((data: string) => void) | null = null;
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;

  loadAddon(addon: unknown): void {
    this.loadedAddons.push(addon);
  }

  open(container: HTMLElement): void {
    this.openedIn = container;
  }

  write(data: Uint8Array): void {
    this.writes.push(data.slice());
  }

  reset(): void {
    this.resetCount += 1;
  }

  focus(): void {
    this.focusCount += 1;
  }

  onData(handler: (data: string) => void): { dispose(): void } {
    this.onDataHandler = handler;
    return { dispose: () => (this.onDataHandler = null) };
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

class FakeFitAddon {
  fitCount = 0;

  fit(): void {
    this.fitCount += 1;
  }
}

class FakeXtermFactory implements XtermFactory {
  terminalCalls = 0;
  fitAddonCalls = 0;
  readonly terminal = new FakeTerminal();
  readonly fitAddon = new FakeFitAddon();

  createTerminal(): Terminal {
    this.terminalCalls += 1;
    return this.terminal as unknown as Terminal;
  }

  createFitAddon(): FitAddon {
    this.fitAddonCalls += 1;
    return this.fitAddon as unknown as FitAddon;
  }
}

describe("XtermAdapter", () => {
  it("uses the workspace terminal palette and type scale", () => {
    const factory = new FakeXtermFactory();

    new XtermAdapter(factory);

    expect(factory.terminal.options).toMatchObject({
      fontFamily: '"Fira Code Variable", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      theme: {
        background: "#111417",
        foreground: "#d7dbe0",
        cursor: "#d7dbe0",
        selectionBackground: "#564070",
      },
    });
  });

  it("creates exactly one Terminal and one FitAddon across repeated mounts", () => {
    const factory = new FakeXtermFactory();
    const adapter = new XtermAdapter(factory);
    const first = document.createElement("div");

    adapter.mount(first);
    adapter.mount(document.createElement("div"));

    expect(factory.terminalCalls).toBe(1);
    expect(factory.fitAddonCalls).toBe(1);
    expect(factory.terminal.loadedAddons).toEqual([factory.fitAddon]);
    expect(factory.terminal.openedIn).toBe(first);
  });

  it("maps input to UTF-8 bytes only while input is enabled", () => {
    const factory = new FakeXtermFactory();
    const adapter = new XtermAdapter(factory);
    const received: Uint8Array[] = [];
    adapter.subscribeInput(({ bytes }) => received.push(bytes));

    factory.terminal.onDataHandler?.("가");
    adapter.setInputEnabled(true);
    factory.terminal.onDataHandler?.("가");
    adapter.setInputEnabled(false);
    factory.terminal.onDataHandler?.("나");

    expect(received).toEqual([new TextEncoder().encode("가")]);
    expect(factory.terminal.options.disableStdin).toBe(true);
    expect(factory.terminal.resetCount).toBe(0);
  });

  it("writes, resets, fits, and focuses through the single renderer", () => {
    const factory = new FakeXtermFactory();
    const adapter = new XtermAdapter(factory);
    factory.terminal.cols = 100;
    factory.terminal.rows = 30;

    adapter.write(Uint8Array.of(1, 2));
    adapter.reset();
    const size = adapter.fit();
    adapter.focus();

    expect(factory.terminal.writes).toEqual([Uint8Array.of(1, 2)]);
    expect(factory.terminal.resetCount).toBe(1);
    expect(factory.fitAddon.fitCount).toBe(1);
    expect(size).toEqual({ cols: 100, rows: 30 });
    expect(factory.terminal.focusCount).toBe(1);
  });

  it("hands Tab to the browser while retaining other terminal keys", () => {
    const factory = new FakeXtermFactory();
    new XtermAdapter(factory);

    expect(factory.terminal.keyHandler?.(new KeyboardEvent("keydown", { key: "Tab" }))).toBe(false);
    expect(factory.terminal.keyHandler?.(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  });

  it("disposes subscriptions and the terminal exactly once", () => {
    const factory = new FakeXtermFactory();
    const adapter = new XtermAdapter(factory);
    const received: Uint8Array[] = [];
    adapter.subscribeInput(({ bytes }) => received.push(bytes));
    adapter.setInputEnabled(true);

    adapter.dispose();
    adapter.dispose();
    factory.terminal.onDataHandler?.("ignored");

    expect(factory.terminal.disposeCount).toBe(1);
    expect(factory.terminal.onDataHandler).toBeNull();
    expect(received).toEqual([]);
  });
});

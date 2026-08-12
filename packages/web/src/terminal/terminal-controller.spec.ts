import { describe, expect, it } from "vitest";

import { FakeTerminalAdapterFactory } from "../test/fake-terminal-adapter.js";
import { TerminalController } from "./terminal-controller.js";

class FakeFrameScheduler {
  readonly callbacks: Array<() => void> = [];
  cancelled = 0;

  schedule(callback: () => void): () => void {
    this.callbacks.push(callback);
    return () => {
      this.cancelled += 1;
    };
  }

  flush(): void {
    this.callbacks.shift()?.();
  }
}

function setup() {
  const adapters = new FakeTerminalAdapterFactory();
  const frames = new FakeFrameScheduler();
  const sent: Uint8Array[] = [];
  const resized: Array<{ cols: number; rows: number }> = [];
  const controller = new TerminalController(
    { adapterFactory: adapters, frameScheduler: frames },
    {
      terminalId: 11,
      sendInput: (bytes) => sent.push(bytes),
      resize: (size) => resized.push(size),
    },
  );
  return { adapters, controller, frames, resized, sent };
}

describe("TerminalController", () => {
  it("mounts exactly one adapter for its terminal id", () => {
    const { adapters, controller } = setup();
    const first = document.createElement("div");

    controller.mount(first);
    controller.mount(document.createElement("div"));

    expect(adapters.created).toHaveLength(1);
    expect(adapters.created[0]?.mountedIn).toBe(first);
  });

  it("buffers pre-mount output in sequence order and flushes it in one animation frame", () => {
    const { adapters, controller, frames } = setup();
    controller.acceptOutput({ seq: 2, bytes: Uint8Array.of(2), replace: false });
    controller.acceptOutput({ seq: 1, bytes: Uint8Array.of(1), replace: false });

    controller.mount(document.createElement("div"));

    expect(frames.callbacks).toHaveLength(1);
    expect(adapters.created[0]?.writes).toEqual([]);
    frames.flush();
    expect(adapters.created[0]?.writes).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);
    expect(controller.lastSeq()).toBe(2);
  });

  it("forwards input only while allowed and never turns Tab into terminal bytes", () => {
    const { adapters, controller, sent } = setup();
    controller.mount(document.createElement("div"));
    const adapter = adapters.created[0];

    adapter?.input({ bytes: Uint8Array.of(1) });
    controller.setInputAllowed(true);
    adapter?.input({ key: "Tab", bytes: Uint8Array.of(9) });
    adapter?.input({ bytes: Uint8Array.of(2) });
    controller.setInputAllowed(false);
    adapter?.input({ bytes: Uint8Array.of(3) });

    expect(sent).toEqual([Uint8Array.of(2)]);
    expect(adapter?.inputEnabled).toBe(false);
  });

  it("throttles fit to one frame and deduplicates unchanged grid sizes", () => {
    const { adapters, controller, frames, resized } = setup();
    controller.mount(document.createElement("div"));

    controller.requestFit();
    controller.requestFit();
    expect(frames.callbacks).toHaveLength(1);
    frames.flush();
    expect(adapters.created[0]?.fitCount).toBe(1);
    expect(resized).toEqual([{ cols: 80, rows: 24 }]);

    controller.requestFit();
    frames.flush();
    expect(resized).toHaveLength(1);

    if (adapters.created[0]) adapters.created[0].grid = { cols: 100, rows: 30 };
    controller.requestFit();
    frames.flush();
    expect(resized).toEqual([
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
    ]);
  });

  it("keeps tracking and rendering output while its window is hidden", () => {
    const { adapters, controller, frames } = setup();
    controller.mount(document.createElement("div"));
    controller.setVisible(false);

    controller.acceptOutput({ seq: 7, bytes: Uint8Array.of(7), replace: false });
    frames.flush();

    expect(controller.lastSeq()).toBe(7);
    expect(adapters.created[0]?.writes).toEqual([Uint8Array.of(7)]);
  });

  it("cancels scheduled work and listeners when disposed", () => {
    const { adapters, controller, frames, sent } = setup();
    controller.mount(document.createElement("div"));
    controller.setInputAllowed(true);
    controller.acceptOutput({ seq: 1, bytes: Uint8Array.of(1), replace: false });
    controller.requestFit();

    controller.dispose();
    controller.dispose();
    frames.flush();
    adapters.created[0]?.input({ bytes: Uint8Array.of(2) });

    expect(frames.cancelled).toBe(1);
    expect(adapters.created[0]?.writes).toEqual([]);
    expect(adapters.created[0]?.fitCount).toBe(0);
    expect(adapters.created[0]?.disposeCount).toBe(1);
    expect(sent).toEqual([]);
  });
});

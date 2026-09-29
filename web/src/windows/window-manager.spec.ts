import { describe, expect, it } from "vitest";

import { WindowManager } from "./window-manager.js";

describe("WindowManager — shared geometry and participant-local presentation", () => {
  it("reconciles new terminals into a deterministic cascade", () => {
    const first = new WindowManager({ viewport: { width: 1200, height: 700 } });
    const second = new WindowManager({ viewport: { width: 1200, height: 700 } });

    first.reconcile([11, 12, 13]);
    second.reconcile([11, 12, 13]);

    expect(first.view()).toEqual(second.view());
    expect(
      first.view().windows.map(({ terminalId, rect, z }) => ({ terminalId, rect, z })),
    ).toEqual([
      { terminalId: 11, rect: { x: 24, y: 24, width: 640, height: 420 }, z: 1 },
      { terminalId: 12, rect: { x: 56, y: 56, width: 640, height: 420 }, z: 2 },
      { terminalId: 13, rect: { x: 88, y: 88, width: 640, height: 420 }, z: 3 },
    ]);
  });

  it("restores persisted participant geometry before reconciling live terminal ids", () => {
    const manager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    manager.restoreLayout([
      {
        terminalId: 11,
        x: 180,
        y: 120,
        width: 720,
        height: 500,
        z: 4,
        state: "minimized",
      },
    ]);

    manager.reconcile([11, 12]);

    expect(manager.view().windows).toMatchObject([
      {
        terminalId: 11,
        rect: { x: 180, y: 120, width: 720, height: 500 },
        z: 4,
        minimized: true,
      },
      { terminalId: 12, minimized: false },
    ]);
  });

  it("clamps a long cascade so every new title bar remains reachable", () => {
    const manager = new WindowManager({ viewport: { width: 1024, height: 768 } });
    manager.reconcile(Array.from({ length: 40 }, (_, index) => index + 1));

    expect(manager.view().windows.at(-1)?.rect).toMatchObject({ x: 976, y: 720 });
  });

  it("raises the activated window without changing its geometry", () => {
    const manager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    manager.reconcile([11, 12]);
    const before = manager.view().windows[0];

    manager.activate(11);

    const after = manager.view().windows[0];
    expect(after?.rect).toEqual(before?.rect);
    expect(after?.z).toBe(3);
    expect(manager.view().windows[1]?.z).toBe(2);
  });

  it("clamps moves and resizes to workspace bounds", () => {
    const manager = new WindowManager({ viewport: { width: 1024, height: 768 } });
    manager.reconcile([11]);

    manager.move(11, { x: 1200, y: 900 });
    manager.setGeometry(11, { x: 976, y: 720, width: 100, height: 100 });

    expect(manager.view().windows[0]?.rect).toEqual({
      x: 976,
      y: 720,
      width: 360,
      height: 240,
    });
  });

  it("uses a stable shared workspace larger than the participant viewport", () => {
    const manager = new WindowManager({
      viewport: { width: 1_024, height: 768 },
      workspace: { width: 4_096, height: 2_304 },
    });
    manager.reconcile([11]);

    manager.move(11, { x: 3_000, y: 1_700 });

    expect(manager.view().windows[0]?.rect).toMatchObject({ x: 3_000, y: 1_700 });
  });

  it("minimizes and restores without losing the floating geometry", () => {
    const manager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    manager.reconcile([11]);
    const rect = manager.view().windows[0]?.rect;

    manager.minimize(11);
    expect(manager.view().windows[0]?.minimized).toBe(true);

    manager.restore(11);
    expect(manager.view().windows[0]).toMatchObject({ minimized: false, maximized: false, rect });
  });

  it("arranges every non-minimized window into tiles", () => {
    const manager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    manager.reconcile([11, 12, 13]);
    manager.minimize(12);

    manager.arrange();

    expect(manager.view().windows).toMatchObject([
      { terminalId: 11, rect: { x: 0, y: 0, width: 600, height: 700 } },
      { terminalId: 12, minimized: true },
      { terminalId: 13, rect: { x: 600, y: 0, width: 600, height: 700 } },
    ]);
  });

  it.each([
    ["left", { x: 0, y: 0, width: 600, height: 800 }],
    ["right", { x: 600, y: 0, width: 600, height: 800 }],
    ["top-left", { x: 0, y: 0, width: 600, height: 400 }],
    ["top-right", { x: 600, y: 0, width: 600, height: 400 }],
    ["bottom-left", { x: 0, y: 400, width: 600, height: 400 }],
    ["bottom-right", { x: 600, y: 400, width: 600, height: 400 }],
  ] as const)("snaps a floating window to the %s workspace region", (zone, expected) => {
    const manager = new WindowManager({ viewport: { width: 1200, height: 800 } });
    manager.reconcile([11]);

    manager.snap(11, zone);

    expect(manager.view().windows[0]).toMatchObject({
      rect: expected,
      minimized: false,
      maximized: false,
    });
  });

  it("focuses one maximized window while leaving the others available for the Dock", () => {
    const manager = new WindowManager({ viewport: { width: 1280, height: 800 } });
    manager.reconcile([11, 12]);
    const otherRect = manager.view().windows[1]?.rect;

    manager.maximize(11);

    expect(manager.view().windows).toMatchObject([
      {
        terminalId: 11,
        rect: { x: 0, y: 0, width: 1280, height: 800 },
        maximized: true,
        minimized: false,
      },
      { terminalId: 12, rect: otherRect, minimized: false, maximized: false },
    ]);
  });

  it("preserves shared floating geometry when the participant viewport changes", () => {
    const manager = new WindowManager({ viewport: { width: 1920, height: 1080 } });
    manager.reconcile([11]);
    manager.move(11, { x: 1800, y: 1000 });

    manager.setViewport({ width: 1024, height: 768 });

    expect(manager.view().windows[0]?.rect).toEqual({ x: 1800, y: 1000, width: 640, height: 420 });
  });

  it("enters and exits overview without rewriting window geometry", () => {
    const manager = new WindowManager({ viewport: { width: 1280, height: 800 } });
    manager.reconcile([11, 12]);
    const before = manager.view().windows;

    manager.enterOverview();
    expect(manager.view()).toMatchObject({ overview: true, windows: before });

    manager.exitOverview();
    expect(manager.view()).toMatchObject({ overview: false, windows: before });
  });

  it("publishes immutable snapshots until the subscriber is removed", () => {
    const manager = new WindowManager({ viewport: { width: 1280, height: 800 } });
    const views: unknown[] = [];
    const unsubscribe = manager.subscribe((view) => views.push(view));

    manager.reconcile([11]);
    unsubscribe();
    manager.activate(11);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ windows: [{ terminalId: 11 }] });
  });

  it("applies shared geometry while preserving participant-local maximized state", () => {
    const manager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    manager.reconcile([11, 12]);
    manager.maximize(12);
    const first = { x: 180, y: 96, width: 700, height: 460 };
    const second = { x: 940, y: 120, width: 680, height: 440 };

    manager.syncSharedGeometry([
      { terminalId: 11, geometry: first },
      { terminalId: 12, geometry: second },
    ]);

    expect(manager.view().windows.find(({ terminalId }) => terminalId === 11)?.rect).toEqual(first);
    expect(manager.view().windows.find(({ terminalId }) => terminalId === 12)).toMatchObject({
      rect: { x: 0, y: 0, width: 1200, height: 700 },
      restoreRect: second,
      maximized: true,
    });
    manager.restore(12);
    expect(manager.view().windows.find(({ terminalId }) => terminalId === 12)?.rect).toEqual(
      second,
    );
  });
});

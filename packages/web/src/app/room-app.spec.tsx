import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RoomProjection } from "../projection/room-projection.js";
import { WindowManager } from "../windows/window-manager.js";
import {
  RoomApp,
  RoomAppRuntime,
  type RoomAppSession,
  type RuntimeTerminalController,
} from "./room-app.js";

import type { RoomSnapshot } from "@ttyroom/protocol";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

describe("RoomApp production composition", () => {
  it("automatically rejoins a room when the browser has a saved nickname", () => {
    const projection = new RoomProjection();
    const start = vi.fn();

    const runtime = new RoomAppRuntime({
      ...runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
      identity: {
        clientId: () => "client-1",
        nickname: () => "Donghyeon",
        saveNickname: vi.fn(),
      },
      createSession: () => makeSession({ start }),
    });

    expect(runtime.view().state).toBe("joining");
    expect(start).toHaveBeenCalledOnce();

    runtime.dispose();
  });

  it("joins through the stable session boundary and reconciles terminal-scoped controller lifetimes", async () => {
    const projection = new RoomProjection();
    let sessionEvent:
      | ((
          event: Parameters<RoomAppSession["subscribe"]>[0] extends (event: infer T) => void
            ? T
            : never,
        ) => void)
      | null = null;
    const session = makeSession({
      subscribe: (subscriber) => {
        sessionEvent = subscriber;
        return () => undefined;
      },
    });
    const controllers = new Map<
      number,
      RuntimeTerminalController & { dispose: ReturnType<typeof vi.fn> }
    >();
    const runtime = new RoomAppRuntime({
      route: { kind: "room", roomId: "room-1", token: "secret" },
      identity: { clientId: () => "client-1", nickname: () => null, saveNickname: vi.fn() },
      projection,
      windowManager: new WindowManager({ viewport: { width: 1200, height: 700 } }),
      createSession: () => session,
      createController: (terminalId) => {
        const controller = makeController();
        controllers.set(terminalId, controller);
        return controller;
      },
      createRoom: vi.fn(),
      navigate: vi.fn(),
      copyInvite: vi.fn(),
    });
    render(<RoomApp runtime={runtime} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Nickname" }), "Donghyeon");
    await userEvent.click(screen.getByRole("button", { name: "Join room" }));
    expect(session.start).toHaveBeenCalledOnce();

    act(() =>
      projection.applyServerMessage({
        type: "welcome",
        selfClientId: "client-1",
        snapshot: snapshot([1, 2]),
      }),
    );
    expect(runtime.controllerCount()).toBe(2);
    act(() => {
      projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 0 });
      projection.applyServerMessage({ type: "sync", terminalId: 2, seq: 0 });
    });
    act(() => sessionEvent?.({ kind: "lease-acquired", terminalId: 1 }));
    expect(screen.getByText("Control acquired · terminal-1")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open room menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Add host" }));
    expect(screen.getByRole("dialog", { name: "Add Host" })).toHaveTextContent(
      "Waiting for Agent…",
    );
    act(() =>
      projection.applyServerMessage({
        type: "welcome",
        selfClientId: "client-1",
        snapshot: {
          ...snapshot([1, 2]),
          hosts: [
            ...snapshot([1, 2]).hosts,
            { hostId: "host-2", name: "Minsu-Mac", online: true, remoteInputAllowed: true },
          ],
        },
      }),
    );
    expect(screen.getByRole("dialog", { name: "Add Host" })).toHaveTextContent(
      "Minsu-Mac connected",
    );
    await userEvent.click(screen.getByRole("button", { name: "Close Add Host" }));
    await userEvent.click(screen.getByRole("button", { name: "Close terminal-1" }));
    expect(session.closeTerminal).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(session.closeTerminal).toHaveBeenCalledWith(1);
    act(() => sessionEvent?.({ kind: "reset-terminal-output", terminalId: 2 }));
    expect(controllers.get(2)?.resetOutput).toHaveBeenCalledOnce();
    act(() =>
      projection.applyServerMessage({
        type: "welcome",
        selfClientId: "client-1",
        snapshot: snapshot([2]),
      }),
    );
    expect(controllers.get(1)?.dispose).toHaveBeenCalledOnce();
    expect(controllers.get(2)?.dispose).not.toHaveBeenCalled();

    runtime.dispose();
    runtime.dispose();
    expect(controllers.get(2)?.dispose).toHaveBeenCalledOnce();
    expect(session.stop).toHaveBeenCalledOnce();
  });

  it("opens rename from a terminal menu and sends the normalized name through the session", async () => {
    const projection = new RoomProjection();
    const renameTerminal = vi.fn();
    const runtime = new RoomAppRuntime({
      ...runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
      createSession: () => makeSession({ renameTerminal }),
    });
    runtime.join("room-1", "Donghyeon");
    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: snapshot([1]),
    });
    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 0 });
    render(<RoomApp runtime={runtime} />);

    await userEvent.click(screen.getByRole("button", { name: "Open terminal-1 menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename terminal" }));
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    await userEvent.clear(input);
    await userEvent.type(input, "  API logs  ");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(renameTerminal).toHaveBeenCalledWith(1, "API logs");
    runtime.dispose();
  });

  it("reports activated terminal focus and maps focused participants into each title bar", () => {
    const projection = new RoomProjection();
    const focusTerminal = vi.fn();
    const runtime = new RoomAppRuntime({
      ...runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
      createSession: () => makeSession({ focusTerminal }),
    });
    runtime.join("room-1", "Donghyeon");
    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: {
        ...snapshot([1, 2]),
        participants: [
          { clientId: "client-1", name: "Donghyeon", focusedTerminalId: 1 },
          { clientId: "bob", name: "Bob", focusedTerminalId: 2 },
        ],
      },
    });

    expect(runtime.view().terminals.find(({ terminalId }) => terminalId === 1)).toMatchObject({
      focusedParticipants: [{ clientId: "client-1", name: "You" }],
    });
    expect(runtime.view().terminals.find(({ terminalId }) => terminalId === 2)).toMatchObject({
      focusedParticipants: [{ clientId: "bob", name: "Bob" }],
    });
    expect(focusTerminal).toHaveBeenCalledWith(2);
    focusTerminal.mockClear();

    runtime.activate(1);
    expect(focusTerminal).toHaveBeenCalledWith(1);
    runtime.dispose();
  });

  it("shows remote participant cursors briefly and never retains the local cursor", () => {
    vi.useFakeTimers();
    const projection = new RoomProjection();
    let sessionEvent: Parameters<RoomAppSession["subscribe"]>[0] | undefined;
    const runtime = new RoomAppRuntime({
      ...runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
      createSession: () =>
        makeSession({
          subscribe: (subscriber) => {
            sessionEvent = subscriber;
            return () => undefined;
          },
        }),
    });
    runtime.join("room-1", "Donghyeon");
    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: {
        ...snapshot([]),
        participants: [
          { clientId: "client-1", name: "Donghyeon", focusedTerminalId: null },
          { clientId: "bob", name: "Bob", focusedTerminalId: null },
        ],
      },
    });

    sessionEvent?.({
      kind: "participant-cursor",
      clientId: "bob",
      position: { x: 320, y: 180 },
    });
    sessionEvent?.({
      kind: "participant-cursor",
      clientId: "client-1",
      position: { x: 80, y: 40 },
    });

    expect(runtime.view().cursors).toEqual([
      { clientId: "bob", name: "Bob", position: { x: 320, y: 180 } },
    ]);

    vi.advanceTimersByTime(2_000);
    expect(runtime.view().cursors).toEqual([]);
    runtime.dispose();
    vi.useRealTimers();
  });

  it("projects welcome and room-event geometry into the visible terminal window", () => {
    const projection = new RoomProjection();
    const windowManager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    const runtime = new RoomAppRuntime(runtimeDeps(projection, windowManager));
    const initial = { x: 180, y: 92, width: 720, height: 470 };
    const moved = { x: 320, y: 144, width: 760, height: 510 };
    const room = snapshot([1]);
    room.terminals[0]!.geometry = initial;

    projection.applyServerMessage({ type: "welcome", selfClientId: "client-1", snapshot: room });
    expect(runtime.view().terminals[0]?.rect).toEqual(initial);

    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "terminal-geometry-changed", terminalId: 1, geometry: moved },
    });
    expect(runtime.view().terminals[0]?.rect).toEqual(moved);
    runtime.dispose();
  });

  it("publishes the committed full geometry after local move and resize", () => {
    const projection = new RoomProjection();
    const updateGeometry = vi.fn();
    const runtime = new RoomAppRuntime({
      ...runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
      createSession: () => makeSession({ updateGeometry }),
    });
    runtime.join("room-1", "Donghyeon");
    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: snapshot([1]),
    });

    runtime.move(1, { x: 180, y: 92 });
    runtime.resize(1, { width: 720, height: 480 });

    expect(updateGeometry).toHaveBeenNthCalledWith(1, 1, {
      x: 180,
      y: 92,
      width: 640,
      height: 420,
    });
    expect(updateGeometry).toHaveBeenNthCalledWith(2, 1, {
      x: 180,
      y: 92,
      width: 720,
      height: 480,
    });
    runtime.dispose();
  });

  it("does not roll back a local geometry commit on unrelated terminal output", () => {
    const projection = new RoomProjection();
    const runtime = new RoomAppRuntime(
      runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
    );
    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: snapshot([1]),
    });
    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 0 });
    runtime.move(1, { x: 180, y: 92 });

    projection.applyOutput({
      kind: "output",
      terminalId: 1,
      seq: 1,
      payload: new Uint8Array([65]),
    });

    expect(runtime.view().terminals[0]?.rect).toMatchObject({ x: 180, y: 92 });
    runtime.dispose();
  });

  it("publishes every visible terminal geometry after Arrange", () => {
    const projection = new RoomProjection();
    const updateGeometry = vi.fn();
    const runtime = new RoomAppRuntime({
      ...runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
      createSession: () => makeSession({ updateGeometry }),
    });
    runtime.join("room-1", "Donghyeon");
    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: snapshot([1, 2]),
    });

    runtime.arrange();

    expect(updateGeometry).toHaveBeenCalledTimes(2);
    expect(updateGeometry).toHaveBeenCalledWith(1, {
      x: 0,
      y: 0,
      width: 600,
      height: 700,
    });
    expect(updateGeometry).toHaveBeenCalledWith(2, {
      x: 600,
      y: 0,
      width: 600,
      height: 700,
    });
    runtime.dispose();
  });

  it("preserves canvas geometry and updates the desktop input guard when the viewport changes", () => {
    const projection = new RoomProjection();
    const windowManager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    const runtime = runtimeForViewport({ projection, windowManager });
    windowManager.reconcile([1]);
    windowManager.move(1, { x: 1100, y: 650 });

    runtime.resizeViewport({ width: 900, height: 574 });

    expect(windowManager.view().windows[0]?.rect).toMatchObject({ x: 1100, y: 650 });
    expect(runtime.inputBlocked()).toBe(true);

    runtime.resizeViewport({ width: 1280, height: 606 });
    expect(runtime.inputBlocked()).toBe(false);
    runtime.dispose();
  });

  it("expires transient toast feedback instead of retaining an append-only history", () => {
    vi.useFakeTimers();
    const projection = new RoomProjection();
    const sessionEvents: { current?: Parameters<RoomAppSession["subscribe"]>[0] } = {};
    const runtime = runtimeForToast(projection, (subscriber) => {
      sessionEvents.current = subscriber;
      return () => undefined;
    });
    runtime.join("room-1", "Donghyeon");
    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: snapshot([1]),
    });

    sessionEvents.current?.({ kind: "lease-acquired", terminalId: 1 });
    expect(runtime.view().toasts).toHaveLength(1);

    vi.advanceTimersByTime(4_000);
    expect(runtime.view().toasts).toHaveLength(0);
    runtime.dispose();
    vi.useRealTimers();
  });
});

function runtimeForToast(
  projection: RoomProjection,
  subscribe: RoomAppSession["subscribe"],
): RoomAppRuntime {
  return new RoomAppRuntime({
    ...runtimeDeps(projection, new WindowManager({ viewport: { width: 1200, height: 700 } })),
    createSession: () => makeSession({ subscribe }),
  });
}

function runtimeForViewport({
  projection,
  windowManager,
}: {
  projection: RoomProjection;
  windowManager: WindowManager;
}) {
  return new RoomAppRuntime(runtimeDeps(projection, windowManager));
}

function runtimeDeps(projection: RoomProjection, windowManager: WindowManager) {
  return {
    route: { kind: "room", roomId: "room-1", token: "secret" },
    identity: { clientId: () => "client-1", nickname: () => null, saveNickname: vi.fn() },
    projection,
    windowManager,
    createSession: () => makeSession(),
    createController: () => makeController(),
    createRoom: vi.fn(),
    navigate: vi.fn(),
    copyInvite: vi.fn(),
  } as const;
}

function makeSession(overrides: Partial<RoomAppSession> = {}): RoomAppSession {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: () => () => undefined,
    takeControl: vi.fn(),
    releaseControl: vi.fn(),
    closeTerminal: vi.fn(),
    openTerminal: vi.fn(),
    resize: vi.fn(),
    updateGeometry: vi.fn(),
    renameTerminal: vi.fn(),
    setMode: vi.fn(),
    focusTerminal: vi.fn(),
    moveCursor: vi.fn(),
    ...overrides,
  };
}

function makeController(): RuntimeTerminalController & { dispose: ReturnType<typeof vi.fn> } {
  return {
    mount: vi.fn(),
    requestFit: vi.fn(),
    setInputAllowed: vi.fn(),
    setVisible: vi.fn(),
    acceptOutput: vi.fn(),
    resetOutput: vi.fn(),
    dispose: vi.fn(),
  };
}

function snapshot(terminalIds: readonly number[]): RoomSnapshot {
  return {
    roomId: "room-1",
    name: "Payment Debug",
    participants: [{ clientId: "client-1", name: "Donghyeon", focusedTerminalId: null }],
    hosts: [{ hostId: "host-1", name: "Donghyeon-Mac", online: true, remoteInputAllowed: true }],
    terminals: terminalIds.map((terminalId) => ({
      terminalId,
      hostId: "host-1",
      title: `terminal-${terminalId}`,
      geometry: {
        x: 24 + (terminalId - 1) * 32,
        y: 24 + (terminalId - 1) * 32,
        width: 640,
        height: 420,
      },
      mode: "exclusive",
      status: "open",
      exitCode: null,
      meta: { cwd: "/workspace", gitBranch: "main", fgProcess: "node" },
    })),
    leases: [],
  };
}

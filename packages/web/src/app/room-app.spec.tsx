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
  it("joins through the stable session boundary and reconciles terminal-scoped controller lifetimes", async () => {
    const projection = new RoomProjection();
    let sessionEvent:
      | ((
          event: Parameters<RoomAppSession["subscribe"]>[0] extends (event: infer T) => void
            ? T
            : never,
        ) => void)
      | null = null;
    const session: RoomAppSession = {
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: (subscriber) => {
        sessionEvent = subscriber;
        return () => undefined;
      },
      takeControl: vi.fn(),
      releaseControl: vi.fn(),
      closeTerminal: vi.fn(),
      openTerminal: vi.fn(),
      resize: vi.fn(),
      setMode: vi.fn(),
    };
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
        const controller = {
          mount: vi.fn(),
          setInputAllowed: vi.fn(),
          setVisible: vi.fn(),
          acceptOutput: vi.fn(),
          resetOutput: vi.fn(),
          dispose: vi.fn(),
        };
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
    await userEvent.click(screen.getAllByRole("button", { name: "Add host" })[0]!);
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

  it("clamps local windows and updates the desktop input guard when the viewport changes", () => {
    const projection = new RoomProjection();
    const windowManager = new WindowManager({ viewport: { width: 1200, height: 700 } });
    const runtime = runtimeForViewport({ projection, windowManager });
    windowManager.reconcile([1]);
    windowManager.move(1, { x: 1100, y: 650 });

    runtime.resizeViewport({ width: 900, height: 574 });

    expect(windowManager.view().windows[0]?.rect).toMatchObject({ x: 852, y: 526 });
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
    createSession: () => ({
      start: vi.fn(),
      stop: vi.fn(),
      subscribe,
      takeControl: vi.fn(),
      releaseControl: vi.fn(),
      closeTerminal: vi.fn(),
      openTerminal: vi.fn(),
      resize: vi.fn(),
      setMode: vi.fn(),
    }),
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
    createSession: () => ({
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: () => () => undefined,
      takeControl: vi.fn(),
      releaseControl: vi.fn(),
      closeTerminal: vi.fn(),
      openTerminal: vi.fn(),
      resize: vi.fn(),
      setMode: vi.fn(),
    }),
    createController: () => ({
      mount: vi.fn(),
      setInputAllowed: vi.fn(),
      setVisible: vi.fn(),
      acceptOutput: vi.fn(),
      resetOutput: vi.fn(),
      dispose: vi.fn(),
    }),
    createRoom: vi.fn(),
    navigate: vi.fn(),
    copyInvite: vi.fn(),
  } as const;
}

function snapshot(terminalIds: readonly number[]): RoomSnapshot {
  return {
    roomId: "room-1",
    name: "Payment Debug",
    participants: [{ clientId: "client-1", name: "Donghyeon" }],
    hosts: [{ hostId: "host-1", name: "Donghyeon-Mac", online: true, remoteInputAllowed: true }],
    terminals: terminalIds.map((terminalId) => ({
      terminalId,
      hostId: "host-1",
      title: `terminal-${terminalId}`,
      mode: "exclusive",
      status: "open",
      exitCode: null,
      meta: { cwd: "/workspace", gitBranch: "main", fgProcess: "node" },
    })),
    leases: [],
  };
}

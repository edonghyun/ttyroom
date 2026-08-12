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
});

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

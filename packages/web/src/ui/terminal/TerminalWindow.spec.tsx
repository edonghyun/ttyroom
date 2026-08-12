import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FakeTerminalAdapterFactory } from "../../test/fake-terminal-adapter.js";
import { TerminalController } from "../../terminal/terminal-controller.js";
import { TerminalWindow } from "./TerminalWindow.js";

describe("TerminalWindow", () => {
  it("mounts one renderer, activates on click, and acquires only through Take control", async () => {
    const adapters = new FakeTerminalAdapterFactory();
    const controller = new TerminalController(
      { adapterFactory: adapters, frameScheduler: { schedule: () => () => undefined } },
      { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
    );
    const activate = vi.fn();
    const takeControl = vi.fn();
    const props = windowProps(controller, activate, takeControl);
    const { rerender } = render(<TerminalWindow {...props} />);

    await userEvent.click(screen.getByRole("group", { name: "backend terminal" }));
    expect(activate).toHaveBeenCalledWith(11);
    expect(takeControl).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Take control of backend" }));
    expect(takeControl).toHaveBeenCalledWith(11);

    rerender(<TerminalWindow {...props} overview />);
    expect(adapters.created).toHaveLength(1);
    expect(adapters.created[0]?.inputEnabled).toBe(false);
  });

  it("blocks input while restoring and exposes exited recovery actions", async () => {
    const adapters = new FakeTerminalAdapterFactory();
    const controller = new TerminalController(
      { adapterFactory: adapters, frameScheduler: { schedule: () => () => undefined } },
      { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
    );
    const actions = windowProps(controller, vi.fn(), vi.fn()).actions;
    const openNew = vi.fn();
    render(
      <TerminalWindow
        {...windowProps(controller, vi.fn(), vi.fn())}
        model={{
          ...windowProps(controller, vi.fn(), vi.fn()).model,
          status: { kind: "exited", exitCode: 137 },
        }}
        actions={{ ...actions, openNew }}
        inputBlocked
      />,
    );

    expect(adapters.created[0]?.inputEnabled).toBe(false);
    expect(screen.getByRole("status", { name: "Exited (137)" })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Open a new terminal on Donghyeon-Mac" }),
    );
    expect(openNew).toHaveBeenCalledWith("Donghyeon-Mac");
  });

  it.each([
    ["left", { x: 1, y: 400 }, { x: 0, y: 0, width: 600, height: 800 }],
    ["right", { x: 1199, y: 400 }, { x: 600, y: 0, width: 600, height: 800 }],
    ["top-left", { x: 1, y: 1 }, { x: 0, y: 0, width: 600, height: 400 }],
    ["bottom-right", { x: 1199, y: 799 }, { x: 600, y: 400, width: 600, height: 400 }],
  ] as const)(
    "previews and commits a %s snap when its title bar reaches the workspace edge",
    (zone, pointer, expected) => {
      const adapters = new FakeTerminalAdapterFactory();
      const controller = new TerminalController(
        { adapterFactory: adapters, frameScheduler: { schedule: () => () => undefined } },
        { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
      );
      const props = windowProps(controller, vi.fn(), vi.fn());
      const { container } = render(
        <div className="terminal-scene">
          <TerminalWindow {...props} />
        </div>,
      );
      const scene = container.querySelector<HTMLElement>(".terminal-scene");
      const titlebar = container.querySelector<HTMLElement>(".terminal-titlebar");
      if (!scene || !titlebar) throw new Error("terminal scene did not render");
      vi.spyOn(scene, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1200,
        bottom: 800,
        width: 1200,
        height: 800,
        toJSON: () => ({}),
      });

      fireEvent.pointerDown(titlebar, { clientX: 400, clientY: 200 });
      fireEvent.pointerMove(window, { clientX: pointer.x, clientY: pointer.y });

      expect(screen.getByRole("status", { name: `Snap preview: ${zone}` })).toBeVisible();

      fireEvent.pointerUp(window, { clientX: pointer.x, clientY: pointer.y });

      expect(props.actions.move).toHaveBeenCalledWith(11, {
        x: expected.x,
        y: expected.y,
      });
      expect(props.actions.resize).toHaveBeenCalledWith(11, {
        width: expected.width,
        height: expected.height,
      });
      expect(screen.queryByRole("status", { name: `Snap preview: ${zone}` })).toBeNull();
    },
  );
});

function windowProps(
  controller: TerminalController,
  activate: (id: number) => void,
  takeControl: (id: number) => void,
) {
  return {
    model: {
      terminalId: 11,
      title: "backend",
      host: "Donghyeon-Mac",
      cwd: "~/projects/api",
      branch: "feature/payment",
      status: { kind: "available" } as const,
      mode: "exclusive" as const,
      rect: { x: 62, y: 62, width: 698, height: 613 },
      z: 1,
      minimized: false,
      maximized: false,
    },
    controller,
    active: true,
    overview: false,
    actions: {
      activate,
      takeControl,
      move: vi.fn(),
      resize: vi.fn(),
      minimize: vi.fn(),
      maximize: vi.fn(),
      restore: vi.fn(),
      requestClose: vi.fn(),
      setMode: vi.fn(),
    },
  };
}

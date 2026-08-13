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

  it("shows a compact focus badge and exposes participant names on hover", async () => {
    const adapters = new FakeTerminalAdapterFactory();
    const controller = new TerminalController(
      { adapterFactory: adapters, frameScheduler: { schedule: () => () => undefined } },
      { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
    );
    render(
      <TerminalWindow
        {...windowProps(controller, vi.fn(), vi.fn())}
        model={{
          ...windowProps(controller, vi.fn(), vi.fn()).model,
          focusedParticipants: [
            { clientId: "alice", name: "You" },
            { clientId: "bob", name: "Bob" },
          ],
        }}
      />,
    );

    const badge = screen.getByLabelText("Focused by You, Bob");
    expect(badge).toHaveTextContent("2");
    await userEvent.hover(badge);
    expect(screen.getByRole("tooltip")).toHaveTextContent("You, Bob");
  });

  it("shows the terminal input mode independently from its control status", () => {
    const adapters = new FakeTerminalAdapterFactory();
    const controller = new TerminalController(
      { adapterFactory: adapters, frameScheduler: { schedule: () => () => undefined } },
      { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
    );
    const props = windowProps(controller, vi.fn(), vi.fn());
    const { rerender } = render(<TerminalWindow {...props} />);

    expect(screen.getByRole("img", { name: "Exclusive input mode" })).toHaveTextContent(
      "Exclusive",
    );

    rerender(
      <TerminalWindow
        {...props}
        model={{ ...props.model, mode: "shared", status: { kind: "shared" } }}
      />,
    );
    expect(screen.getByRole("img", { name: "Shared input mode" })).toHaveTextContent("Shared");
  });

  it("opens terminal rename from the title bar actions menu", async () => {
    const requestRename = vi.fn();
    const props = windowProps(createController(), vi.fn(), vi.fn());
    render(<TerminalWindow {...props} actions={{ ...props.actions, requestRename }} />);

    await userEvent.click(screen.getByRole("button", { name: "Open backend menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename terminal" }));

    expect(requestRename).toHaveBeenCalledWith(11);
  });

  it("shows a translucent window ghost that follows the pointer and commits move on release", () => {
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
    mockWorkspaceBounds(scene);

    fireEvent.pointerDown(titlebar, { clientX: 400, clientY: 200 });
    expect(document.body.querySelector(".window-interaction-ghost")).toHaveStyle({
      left: "72px",
      top: "82px",
      width: "698px",
      height: "613px",
    });
    expect(props.actions.move).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { clientX: 440, clientY: 230 });
    expect(document.body.querySelector(".window-interaction-ghost")).toHaveStyle({
      left: "112px",
      top: "112px",
    });
    expect(props.actions.move).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { clientX: 440, clientY: 230 });
    expect(props.actions.move).toHaveBeenCalledWith(11, { x: 102, y: 92 });
    expect(document.body.querySelector(".window-interaction-ghost")).toBeNull();
  });

  it("shows a resize ghost with live dimensions and commits size on release", () => {
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
    const handle = screen.getByRole("button", { name: "Resize backend" });
    if (!scene) throw new Error("terminal scene did not render");
    mockWorkspaceBounds(scene);

    fireEvent.pointerDown(handle, { clientX: 760, clientY: 675 });
    fireEvent.pointerMove(window, { clientX: 800, clientY: 700 });

    const ghost = document.body.querySelector(".window-interaction-ghost");
    expect(ghost).toHaveStyle({ width: "738px", height: "638px" });
    expect(ghost).toHaveTextContent("738 × 638");
    expect(props.actions.resize).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { clientX: 800, clientY: 700 });
    expect(props.actions.resize).toHaveBeenCalledWith(11, { width: 738, height: 638 });
    expect(document.body.querySelector(".window-interaction-ghost")).toBeNull();
  });

  it("converts pointer movement through the camera scale while keeping the ghost screen-aligned", () => {
    const controller = createController();
    const props = windowProps(controller, vi.fn(), vi.fn());
    const { container } = render(
      <div className="terminal-scene">
        <TerminalWindow {...props} viewTransform={{ x: 50, y: 30, scale: 0.5 }} />
      </div>,
    );
    const scene = container.querySelector<HTMLElement>(".terminal-scene");
    const titlebar = container.querySelector<HTMLElement>(".terminal-titlebar");
    if (!scene || !titlebar) throw new Error("terminal scene did not render");
    mockWorkspaceBounds(scene);

    fireEvent.pointerDown(titlebar, { clientX: 200, clientY: 150 });
    expect(document.body.querySelector(".window-interaction-ghost")).toHaveStyle({
      left: "91px",
      top: "81px",
      width: "349px",
      height: "306.5px",
    });

    fireEvent.pointerMove(window, { clientX: 240, clientY: 180 });
    fireEvent.pointerUp(window);

    expect(props.actions.move).toHaveBeenCalledWith(11, { x: 142, y: 122 });
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

function mockWorkspaceBounds(scene: HTMLElement): void {
  vi.spyOn(scene, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 1210,
    bottom: 820,
    width: 1200,
    height: 800,
    toJSON: () => ({}),
  });
}

function createController(): TerminalController {
  return new TerminalController(
    {
      adapterFactory: new FakeTerminalAdapterFactory(),
      frameScheduler: { schedule: () => () => undefined },
    },
    { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
  );
}

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
      focusedParticipants: [],
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
      requestRename: vi.fn(),
      setMode: vi.fn(),
    },
  };
}

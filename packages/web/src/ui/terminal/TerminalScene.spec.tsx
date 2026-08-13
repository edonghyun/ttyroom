import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FakeTerminalAdapterFactory } from "../../test/fake-terminal-adapter.js";
import { TerminalController } from "../../terminal/terminal-controller.js";
import { TerminalScene } from "./TerminalScene.js";

describe("TerminalScene", () => {
  it("keeps one keyed TerminalWindow tree when overview opens", () => {
    const adapters = new FakeTerminalAdapterFactory();
    const controller = new TerminalController(
      { adapterFactory: adapters, frameScheduler: { schedule: () => () => undefined } },
      { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
    );
    const props = sceneProps(controller);
    const { rerender } = render(<TerminalScene {...props} overview={false} />);
    const node = screen.getByRole("group", { name: "backend terminal" });

    rerender(<TerminalScene {...props} overview />);

    expect(screen.getByRole("group", { name: "backend terminal" })).toBe(node);
    expect(adapters.created).toHaveLength(1);
  });

  it("zooms the canvas around its center and exposes the current percentage", () => {
    const controller = createController();
    const { container } = render(<TerminalScene {...sceneProps(controller)} overview={false} />);
    const scene = container.querySelector<HTMLElement>(".terminal-scene");
    if (!scene) throw new Error("terminal scene did not render");
    vi.spyOn(scene, "getBoundingClientRect").mockReturnValue(bounds(1_200, 700));

    expect(screen.getByRole("status", { name: "Canvas zoom" })).toHaveTextContent("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.getByRole("status", { name: "Canvas zoom" })).toHaveTextContent("125%");
    expect(container.querySelector(".terminal-camera")).toHaveStyle({
      transform: "translate(-150px, -87.5px) scale(1.25)",
    });
  });

  it("pans with the hand tool without rewriting terminal geometry", () => {
    const controller = createController();
    const props = sceneProps(controller);
    const { container } = render(<TerminalScene {...props} overview={false} />);
    const scene = container.querySelector<HTMLElement>(".terminal-scene");
    if (!scene) throw new Error("terminal scene did not render");

    fireEvent.click(screen.getByRole("button", { name: "Pan tool" }));
    fireEvent.pointerDown(scene, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(scene, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(scene, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(container.querySelector(".terminal-camera")).toHaveStyle({
      transform: "translate(60px, 40px) scale(1)",
    });
    expect(props.actions.move).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pan tool" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders named remote cursors and reports local pointers in workspace coordinates", () => {
    const controller = createController();
    const props = {
      ...sceneProps(controller),
      cursors: [{ clientId: "bob", name: "Bob", position: { x: 320, y: 180 } }],
    };
    const { container } = render(<TerminalScene {...props} overview={false} />);
    const scene = container.querySelector<HTMLElement>(".terminal-scene");
    if (!scene) throw new Error("terminal scene did not render");
    vi.spyOn(scene, "getBoundingClientRect").mockReturnValue({
      ...bounds(1_200, 700),
      left: 20,
      top: 10,
      right: 1_220,
      bottom: 710,
    });

    expect(screen.getByLabelText("Bob cursor")).toHaveStyle({
      transform: "translate(320px, 180px)",
    });

    fireEvent.pointerMove(scene, { pointerId: 1, clientX: 120, clientY: 60 });
    fireEvent.pointerLeave(scene, { pointerId: 1 });

    expect(props.actions.moveCursor).toHaveBeenNthCalledWith(1, { x: 100, y: 50 });
    expect(props.actions.moveCursor).toHaveBeenNthCalledWith(2, null);
  });

  it("offers host connection from an empty workspace", () => {
    const props = {
      ...sceneProps(createController()),
      terminals: [],
      controllers: new Map(),
      hosts: [],
    };
    render(<TerminalScene {...props} overview={false} />);
    const connectHost = screen.getByRole("button", { name: "Connect a host" });

    fireEvent.click(connectHost);

    expect(props.actions.addHost).toHaveBeenCalledWith(connectHost);
  });

  it("opens a first terminal from a connected host in the empty workspace", () => {
    const props = {
      ...sceneProps(createController()),
      terminals: [],
      controllers: new Map(),
      hosts: [
        { hostId: "host-1", name: "Donghyeon-Mac" },
        { hostId: "host-2", name: "Build Server" },
      ],
    };
    render(<TerminalScene {...props} overview={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Open terminal on Build Server" }));

    expect(props.actions.addTerminal).toHaveBeenCalledWith("host-2");
  });
});

function createController(): TerminalController {
  return new TerminalController(
    {
      adapterFactory: new FakeTerminalAdapterFactory(),
      frameScheduler: { schedule: () => () => undefined },
    },
    { terminalId: 11, sendInput: vi.fn(), resize: vi.fn() },
  );
}

function bounds(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function sceneProps(controller: TerminalController) {
  return {
    terminals: [
      {
        terminalId: 11,
        title: "backend",
        host: "Donghyeon-Mac",
        cwd: "~/projects/api",
        branch: "feature/payment",
        status: { kind: "mine", leaseId: 1 } as const,
        mode: "exclusive" as const,
        focusedParticipants: [],
        rect: { x: 62, y: 62, width: 698, height: 613 },
        z: 1,
        minimized: false,
        maximized: false,
        activity: "Running tests",
      },
    ],
    controllers: new Map([[11, controller]]),
    participants: ["You → backend"],
    cursors: [],
    hosts: [{ hostId: "host-1", name: "Donghyeon-Mac" }],
    activeTerminalId: 11,
    actions: {
      activate: vi.fn(),
      takeControl: vi.fn(),
      move: vi.fn(),
      resize: vi.fn(),
      minimize: vi.fn(),
      maximize: vi.fn(),
      restore: vi.fn(),
      requestClose: vi.fn(),
      requestRename: vi.fn(),
      setMode: vi.fn(),
      exitOverview: vi.fn(),
      addTerminal: vi.fn(),
      addHost: vi.fn(),
      moveCursor: vi.fn(),
    },
  };
}

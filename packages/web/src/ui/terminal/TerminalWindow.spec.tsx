import { render, screen } from "@testing-library/react";
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
    },
  };
}

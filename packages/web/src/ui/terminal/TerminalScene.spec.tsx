import { render, screen } from "@testing-library/react";
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
});

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
        rect: { x: 62, y: 62, width: 698, height: 613 },
        z: 1,
        minimized: false,
        maximized: false,
        activity: "Running tests",
      },
    ],
    controllers: new Map([[11, controller]]),
    participants: ["You → backend"],
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
      exitOverview: vi.fn(),
      addTerminal: vi.fn(),
    },
  };
}

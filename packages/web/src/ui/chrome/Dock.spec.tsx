import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dock } from "./Dock.js";

describe("Dock", () => {
  it("shows metadata and activity only, and restores a minimized terminal", async () => {
    const restore = vi.fn();
    const { container } = render(
      <Dock
        terminals={[
          {
            terminalId: 11,
            title: "backend",
            status: "You control",
            activity: "Running tests",
            minimized: true,
          },
        ]}
        participants={["You → backend"]}
        activeTerminalId={11}
        restore={restore}
        addTerminal={vi.fn()}
      />,
    );

    expect(container.querySelector(".xterm")).not.toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Restore backend" }));
    expect(restore).toHaveBeenCalledWith(11);
  });

  it("keeps Add terminal first and separates participant presence from terminal items", () => {
    const { container } = render(
      <Dock
        terminals={[
          {
            terminalId: 11,
            title: "backend",
            status: "You control",
            activity: "npm run dev",
            minimized: false,
          },
        ]}
        participants={["You → backend", "Minsu → frontend"]}
        activeTerminalId={11}
        restore={vi.fn()}
        addTerminal={vi.fn()}
      />,
    );

    expect(container.querySelector(".dock-terminals")?.firstElementChild).toHaveAccessibleName(
      "Add terminal",
    );
    expect(screen.getByRole("list", { name: "Participant presence" })).toHaveTextContent(
      "You → backendMinsu → frontend",
    );
  });
});

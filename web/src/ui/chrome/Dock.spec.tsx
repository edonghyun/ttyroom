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
        hosts={[{ hostId: "host-1", name: "Donghyeon-Mac" }]}
        addTerminal={vi.fn()}
        addHost={vi.fn()}
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
        hosts={[{ hostId: "host-1", name: "Donghyeon-Mac" }]}
        addTerminal={vi.fn()}
        addHost={vi.fn()}
      />,
    );

    expect(container.querySelector(".dock-terminals")?.firstElementChild).toHaveAccessibleName(
      "Add terminal",
    );
    expect(screen.getByRole("list", { name: "Participant presence" })).toHaveTextContent(
      "You → backendMinsu → frontend",
    );
  });

  it("asks which online host should open a terminal", async () => {
    const addTerminal = vi.fn();
    render(
      <Dock
        terminals={[]}
        participants={[]}
        activeTerminalId={null}
        restore={vi.fn()}
        hosts={[
          { hostId: "host-1", name: "Donghyeon-Mac" },
          { hostId: "host-2", name: "Minsu-Mac" },
        ]}
        addTerminal={addTerminal}
        addHost={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add terminal" }));
    expect(screen.getByRole("menu", { name: "Choose host" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Minsu-Mac" }));
    expect(addTerminal).toHaveBeenCalledWith("host-2");
  });

  it("opens the Add Host flow when no host can create a terminal", async () => {
    const addHost = vi.fn();
    render(
      <Dock
        terminals={[]}
        participants={["You"]}
        activeTerminalId={null}
        restore={vi.fn()}
        hosts={[]}
        addTerminal={vi.fn()}
        addHost={addHost}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add terminal" }));

    expect(addHost).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Choose host" })).not.toBeInTheDocument();
  });
});

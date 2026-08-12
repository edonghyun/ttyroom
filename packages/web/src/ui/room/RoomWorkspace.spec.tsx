import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RoomWorkspace } from "./RoomWorkspace.js";

describe("RoomWorkspace", () => {
  it("identifies five terminals by title, host, cwd, branch, and status without color", () => {
    render(
      <RoomWorkspace
        roomName="Payment Debug"
        connection="connected"
        commands={{ invite: vi.fn(), arrange: vi.fn(), overview: vi.fn(), openMenu: vi.fn() }}
        terminals={[
          terminal(1, "backend", "You control"),
          terminal(2, "frontend", "Minsu controls"),
          terminal(3, "staging logs", "Read only"),
          terminal(4, "tests", "Available"),
          terminal(5, "Claude Code", "Shared input"),
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "Terminal workspace" })).toBeVisible();
    for (const title of ["backend", "frontend", "staging logs", "tests", "Claude Code"]) {
      expect(screen.getByRole("group", { name: `${title} terminal` })).toBeVisible();
    }
    expect(screen.getAllByText("Donghyeon-Mac · ~/projects/api · feature/payment")).toHaveLength(5);
  });

  it("keeps the workspace while reconnecting and blocks narrow viewport input", () => {
    render(
      <RoomWorkspace
        roomName="Payment Debug"
        connection="reconnecting"
        commands={{ invite: vi.fn(), arrange: vi.fn(), overview: vi.fn(), openMenu: vi.fn() }}
        terminals={[]}
        narrowViewport
      />,
    );

    expect(screen.getByRole("region", { name: "Terminal workspace" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Desktop viewport required" })).toHaveTextContent(
      "TTYRoom terminal input requires a desktop viewport",
    );
    expect(screen.getByText("Reconnecting… Processes keep running")).toBeVisible();
  });
});

function terminal(id: number, title: string, statusLabel: string) {
  return {
    terminalId: id,
    title,
    host: "Donghyeon-Mac",
    cwd: "~/projects/api",
    branch: "feature/payment",
    statusLabel,
  };
}

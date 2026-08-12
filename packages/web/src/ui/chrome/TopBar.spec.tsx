import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TopBar } from "./TopBar.js";

describe("TopBar", () => {
  it("shows room-wide status and commands", async () => {
    const arrange = vi.fn();
    const overview = vi.fn();
    render(
      <TopBar
        roomName="Payment Debug"
        connection="connected"
        invite={vi.fn()}
        arrange={arrange}
        overview={overview}
        openMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("Payment Debug")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Connected");
    await userEvent.click(screen.getByRole("button", { name: "Arrange terminals" }));
    await userEvent.click(screen.getByRole("button", { name: "Open overview" }));
    expect(arrange).toHaveBeenCalledOnce();
    expect(overview).toHaveBeenCalledOnce();
  });

  it("uses the terminal product mark and source command grouping", () => {
    const { container } = render(
      <TopBar
        roomName="Payment Debug"
        connection="connected"
        invite={vi.fn()}
        arrange={vi.fn()}
        overview={vi.fn()}
        openMenu={vi.fn()}
        addHost={vi.fn()}
      />,
    );

    expect(container.querySelector(".brand-mark")).toHaveAttribute("data-icon", "terminal");
    expect(container.querySelector(".top-bar nav")?.firstElementChild).toHaveTextContent(
      "Invite link",
    );
    expect(screen.getByRole("button", { name: "Open room menu" })).toHaveTextContent("Room menu");
  });

  it("opens an accessible room menu with working room actions", async () => {
    const invite = vi.fn();
    const addHost = vi.fn();
    render(
      <TopBar
        roomName="Payment Debug"
        connection="connected"
        invite={invite}
        arrange={vi.fn()}
        overview={vi.fn()}
        openMenu={vi.fn()}
        addHost={addHost}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open room menu" }));
    expect(screen.getByRole("menu", { name: "Room menu" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy invite link" }));
    expect(invite).toHaveBeenCalledOnce();
  });
});

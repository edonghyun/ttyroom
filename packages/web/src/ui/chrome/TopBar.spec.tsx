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
});

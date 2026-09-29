import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RoomGone } from "./RoomGone.js";

describe("RoomGone", () => {
  it("replaces the workspace and creates a new Quick Room on request", async () => {
    const createNew = vi.fn();
    render(<RoomGone createNew={createNew} />);

    expect(screen.getByRole("heading", { name: "This Quick Room no longer exists" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Terminal workspace" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create a new room" }));
    expect(createNew).toHaveBeenCalledOnce();
  });
});

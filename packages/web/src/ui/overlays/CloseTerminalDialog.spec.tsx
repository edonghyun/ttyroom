import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CloseTerminalDialog } from "./CloseTerminalDialog.js";

describe("CloseTerminalDialog", () => {
  it("sends close only after explicit confirmation", async () => {
    const confirm = vi.fn();
    render(<CloseTerminalDialog open terminalName="backend" confirm={confirm} cancel={vi.fn()} />);
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(confirm).toHaveBeenCalledOnce();
  });
});

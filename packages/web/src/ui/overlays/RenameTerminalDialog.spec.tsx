import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RenameTerminalDialog } from "./RenameTerminalDialog.js";

describe("RenameTerminalDialog", () => {
  it("prefills the current title and submits one trimmed valid title", async () => {
    const confirm = vi.fn();
    render(<RenameTerminalDialog open terminalName="backend" confirm={confirm} cancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Terminal name" });

    expect(input).toHaveValue("backend");
    await userEvent.clear(input);
    await userEvent.type(input, "  API logs  ");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("API logs");
  });

  it("does not allow a blank or unchanged title", async () => {
    render(<RenameTerminalDialog open terminalName="backend" confirm={vi.fn()} cancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    const save = screen.getByRole("button", { name: "Save name" });

    expect(save).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "   ");
    expect(save).toBeDisabled();
  });
});

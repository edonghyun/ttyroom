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

  it("moves focus into the dialog and restores it when the dialog closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { rerender } = render(
      <CloseTerminalDialog open terminalName="backend" confirm={vi.fn()} cancel={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    rerender(
      <CloseTerminalDialog
        open={false}
        terminalName="backend"
        confirm={vi.fn()}
        cancel={vi.fn()}
      />,
    );
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

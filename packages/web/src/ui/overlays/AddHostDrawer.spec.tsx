import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AddHostDrawer } from "./AddHostDrawer.js";

describe("AddHostDrawer", () => {
  it("keeps command, waiting, success, and failure in one accessible drawer", async () => {
    const copy = vi.fn();
    const close = vi.fn();
    const opener = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={opener}>Add host</button>
        <AddHostDrawer
          open
          command="npx ttyroom join https://room"
          state={{ kind: "waiting" }}
          copy={copy}
          close={close}
          opener={opener}
        />
      </>,
    );

    expect(screen.getByRole("dialog", { name: "Add Host" })).toHaveTextContent(
      "Waiting for Agent…",
    );
    await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(copy).toHaveBeenCalledWith("npx ttyroom join https://room");
    expect(screen.getByText(/Ctrl\+C stops the Host Agent and its PTYs/)).toBeVisible();
    screen.getByRole("button", { name: "Close Add Host" }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Copy command" })).toHaveFocus();
  });
});

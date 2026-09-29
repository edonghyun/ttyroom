import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Overview } from "./Overview.js";

describe("Overview", () => {
  it("labels the mode and exits without rendering duplicate terminal previews", async () => {
    const exit = vi.fn();
    const { container } = render(<Overview open exit={exit} />);
    expect(screen.getByRole("region", { name: "Terminal overview" })).toBeVisible();
    expect(container.querySelector(".xterm")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Exit overview" }));
    expect(exit).toHaveBeenCalledOnce();
  });
});

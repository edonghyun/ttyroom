import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToastRegion } from "./ToastRegion.js";

describe("ToastRegion", () => {
  it("uses polite announcements unless severity is error", () => {
    render(
      <ToastRegion
        toasts={[
          { id: "1", severity: "success", message: "Control acquired · backend" },
          { id: "2", severity: "error", message: "Minsu now controls tests" },
        ]}
      />,
    );
    expect(screen.getByText("Control acquired · backend").closest("[aria-live]"))?.toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(screen.getByText("Minsu now controls tests").closest("[aria-live]"))?.toHaveAttribute(
      "aria-live",
      "assertive",
    );
  });
});

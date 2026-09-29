import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectionBanner } from "./ConnectionBanner.js";

describe("ConnectionBanner", () => {
  it.each([
    ["reconnecting", "Reconnecting… Processes keep running"],
    ["restoring", "Restoring terminals and output…"],
    ["live", "Live"],
  ] as const)("announces %s semantics", (state, copy) => {
    render(<ConnectionBanner state={state} />);
    expect(screen.getByRole("status")).toHaveTextContent(copy);
  });
});

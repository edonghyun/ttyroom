import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TerminalStatus } from "./TerminalStatus.js";

describe("TerminalStatus", () => {
  it.each([
    [{ kind: "mine", leaseId: 1 }, "You control · Esc to release"],
    [{ kind: "available" }, "Available"],
    [{ kind: "held-by-other", holderName: "Minsu" }, "Minsu controls · View only"],
    [{ kind: "read-only", reason: "host-disabled" }, "Read only · Remote input disabled"],
    [{ kind: "shared" }, "Shared input"],
    [{ kind: "exited", exitCode: 2 }, "Exited (2)"],
  ] as const)("uses icon and text for $kind", (status, copy) => {
    render(<TerminalStatus status={status} />);
    expect(screen.getByRole("status")).toHaveAccessibleName(copy);
    expect(screen.getByRole("status").querySelector("svg")).toBeInTheDocument();
  });
});

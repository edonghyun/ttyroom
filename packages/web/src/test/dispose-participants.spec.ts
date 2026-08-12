import { describe, expect, it, vi } from "vitest";

import { disposeParticipants } from "./dispose-participants.js";

describe("disposeParticipants", () => {
  it("closes every browser context even when a health assertion fails", async () => {
    const dispose = vi.fn(async () => undefined);
    const failures = await disposeParticipants([
      {
        assertHealthy: () => {
          throw new Error("page crashed");
        },
        dispose,
      },
    ]);

    expect(dispose).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(1);
  });
});

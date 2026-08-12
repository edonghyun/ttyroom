import { describe, expect, it } from "vitest";

import { clampRect } from "./window-geometry.js";

describe("window geometry", () => {
  it("keeps at least 48 px of the title bar visible", () => {
    const viewport = { width: 1024, height: 768 };

    expect(clampRect({ x: -900, y: -80, width: 640, height: 420 }, viewport)).toEqual({
      x: -592,
      y: 0,
      width: 640,
      height: 420,
    });
    expect(clampRect({ x: 1100, y: 900, width: 640, height: 420 }, viewport)).toEqual({
      x: 976,
      y: 720,
      width: 640,
      height: 420,
    });
  });

  it("enforces the 360 by 240 minimum window size", () => {
    expect(
      clampRect({ x: 10, y: 10, width: 100, height: 100 }, { width: 1280, height: 800 }),
    ).toEqual({ x: 10, y: 10, width: 360, height: 240 });
  });
});

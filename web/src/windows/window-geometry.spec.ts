import { describe, expect, it } from "vitest";

import { clampRect, resizeRect, type ResizeDirection } from "./window-geometry.js";

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

  it.each([
    ["top", { x: 100, y: 80, width: 500, height: 340 }],
    ["top-right", { x: 100, y: 80, width: 540, height: 340 }],
    ["right", { x: 100, y: 100, width: 540, height: 320 }],
    ["bottom-right", { x: 100, y: 100, width: 540, height: 300 }],
    ["bottom", { x: 100, y: 100, width: 500, height: 300 }],
    ["bottom-left", { x: 140, y: 100, width: 460, height: 300 }],
    ["left", { x: 140, y: 100, width: 460, height: 320 }],
    ["top-left", { x: 140, y: 80, width: 460, height: 340 }],
  ] satisfies readonly [ResizeDirection, ReturnType<typeof resizeRect>][])(
    "resizes from the %s edge while preserving the opposite edges",
    (direction, expected) => {
      expect(
        resizeRect(
          { x: 100, y: 100, width: 500, height: 320 },
          direction,
          { x: 40, y: -20 },
          { width: 1200, height: 800 },
        ),
      ).toEqual(expected);
    },
  );

  it("keeps the opposite edge fixed when a left resize reaches minimum width", () => {
    expect(
      resizeRect(
        { x: 100, y: 100, width: 500, height: 320 },
        "left",
        { x: 400, y: 0 },
        { width: 1200, height: 800 },
      ),
    ).toEqual({ x: 240, y: 100, width: 360, height: 320 });
  });
});

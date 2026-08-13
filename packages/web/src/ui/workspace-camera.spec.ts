import { describe, expect, it } from "vitest";

import {
  fitCamera,
  panCamera,
  stepCameraZoom,
  viewportPointToWorkspace,
  zoomCameraAt,
} from "./workspace-camera.js";

describe("workspace camera", () => {
  it("zooms around a screen-space focal point without moving the world point beneath it", () => {
    const camera = zoomCameraAt({ x: 0, y: 0, scale: 1 }, 2, { x: 400, y: 300 });

    expect(camera).toEqual({ x: -400, y: -300, scale: 2 });
    expect({
      x: 400 * camera.scale + camera.x,
      y: 300 * camera.scale + camera.y,
    }).toEqual({ x: 400, y: 300 });
  });

  it("steps through useful zoom levels and clamps the camera to 25–200 percent", () => {
    expect(stepCameraZoom({ x: 0, y: 0, scale: 1 }, 1, { x: 0, y: 0 }).scale).toBe(1.25);
    expect(stepCameraZoom({ x: 0, y: 0, scale: 0.25 }, -1, { x: 0, y: 0 }).scale).toBe(0.25);
    expect(zoomCameraAt({ x: 0, y: 0, scale: 1 }, 4, { x: 0, y: 0 }).scale).toBe(2);
  });

  it("pans independently from terminal layout geometry", () => {
    expect(panCamera({ x: -20, y: 10, scale: 0.75 }, { x: 80, y: -30 })).toEqual({
      x: 60,
      y: -20,
      scale: 0.75,
    });
  });

  it("converts viewport pointers to shared workspace coordinates after pan and zoom", () => {
    expect(
      viewportPointToWorkspace(
        { x: 450, y: 280 },
        { left: 50, top: 20 },
        { x: -100, y: 60, scale: 0.5 },
      ),
    ).toEqual({ x: 1_000, y: 400 });
  });

  it("fits all terminal bounds into the viewport with breathing room", () => {
    expect(
      fitCamera([{ x: 0, y: 0, width: 2_000, height: 1_000 }], { width: 1_000, height: 600 }, 50),
    ).toEqual({ x: 50, y: 75, scale: 0.45 });
    expect(fitCamera([], { width: 1_000, height: 600 }, 50)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });
});

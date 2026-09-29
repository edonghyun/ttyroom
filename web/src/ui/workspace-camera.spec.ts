import { describe, expect, it } from "vitest";

import {
  constrainCamera,
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

  it("keeps a visible portion of the finite workspace at every camera edge", () => {
    const viewport = { width: 1_200, height: 700 };
    const workspace = { width: 4_096, height: 2_304 };

    expect(constrainCamera({ x: 5_000, y: 5_000, scale: 1 }, viewport, workspace, 96)).toEqual({
      x: 96,
      y: 96,
      scale: 1,
    });
    expect(constrainCamera({ x: -5_000, y: -5_000, scale: 1 }, viewport, workspace, 96)).toEqual({
      x: -2_992,
      y: -1_700,
      scale: 1,
    });
  });

  it("centers the workspace when its minimum-zoom surface is smaller than the viewport", () => {
    expect(
      constrainCamera(
        { x: 999, y: 999, scale: 0.25 },
        { width: 1_440, height: 900 },
        { width: 4_096, height: 2_304 },
        96,
      ),
    ).toEqual({ x: 208, y: 162, scale: 0.25 });
    expect(
      constrainCamera(
        { x: 999, y: 999, scale: 0.25 },
        { width: 1_125, height: 622 },
        { width: 4_096, height: 2_304 },
        96,
      ),
    ).toEqual({ x: 50.5, y: 23, scale: 0.25 });
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

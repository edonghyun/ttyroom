import type { Viewport, WindowRect } from "../windows/window-geometry.js";

export interface WorkspaceCamera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_CAMERA: WorkspaceCamera = { x: 0, y: 0, scale: 1 };
export const CAMERA_ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const MIN_CAMERA_SCALE = CAMERA_ZOOM_LEVELS[0];
export const MAX_CAMERA_SCALE = CAMERA_ZOOM_LEVELS.at(-1) ?? 2;

function clampScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_CAMERA_SCALE), MAX_CAMERA_SCALE);
}

export function zoomCameraAt(
  camera: WorkspaceCamera,
  requestedScale: number,
  focalPoint: Point,
): WorkspaceCamera {
  const scale = clampScale(requestedScale);
  const ratio = scale / camera.scale;
  return {
    x: focalPoint.x - (focalPoint.x - camera.x) * ratio,
    y: focalPoint.y - (focalPoint.y - camera.y) * ratio,
    scale,
  };
}

export function stepCameraZoom(
  camera: WorkspaceCamera,
  direction: -1 | 1,
  focalPoint: Point,
): WorkspaceCamera {
  const nextScale =
    direction > 0
      ? (CAMERA_ZOOM_LEVELS.find((scale) => scale > camera.scale + 0.001) ?? MAX_CAMERA_SCALE)
      : ([...CAMERA_ZOOM_LEVELS].reverse().find((scale) => scale < camera.scale - 0.001) ??
        MIN_CAMERA_SCALE);
  return zoomCameraAt(camera, nextScale, focalPoint);
}

export function panCamera(camera: WorkspaceCamera, delta: Point): WorkspaceCamera {
  return { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
}

export function viewportPointToWorkspace(
  viewportPoint: Point,
  viewportOrigin: { readonly left: number; readonly top: number },
  camera: WorkspaceCamera,
): Point {
  return {
    x: (viewportPoint.x - viewportOrigin.left - camera.x) / camera.scale,
    y: (viewportPoint.y - viewportOrigin.top - camera.y) / camera.scale,
  };
}

export function fitCamera(
  rects: readonly WindowRect[],
  viewport: Viewport,
  padding = 64,
): WorkspaceCamera {
  if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) return DEFAULT_CAMERA;

  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clampScale(Math.min(1, availableWidth / width, availableHeight / height));

  return {
    x: viewport.width / 2 - (left + width / 2) * scale,
    y: viewport.height / 2 - (top + height / 2) * scale,
    scale,
  };
}

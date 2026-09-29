export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SnapZone = "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type ResizeDirection =
  "top" | "top-right" | "right" | "bottom-right" | "bottom" | "bottom-left" | "left" | "top-left";

export const DEFAULT_WINDOW_SIZE = { width: 640, height: 420 } as const;
export const MIN_WINDOW_SIZE = { width: 360, height: 240 } as const;
export const MIN_VISIBLE_TITLEBAR = 48;

function between(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function clampRect(rect: WindowRect, viewport: Viewport): WindowRect {
  const width = between(
    rect.width,
    Math.min(MIN_WINDOW_SIZE.width, viewport.width),
    viewport.width,
  );
  const height = between(
    rect.height,
    Math.min(MIN_WINDOW_SIZE.height, viewport.height),
    viewport.height,
  );
  const visibleTitlebar = Math.min(MIN_VISIBLE_TITLEBAR, width, viewport.width);
  const visibleVertically = Math.min(MIN_VISIBLE_TITLEBAR, viewport.height);

  return {
    x: between(rect.x, visibleTitlebar - width, viewport.width - visibleTitlebar),
    y: between(rect.y, 0, viewport.height - visibleVertically),
    width,
    height,
  };
}

export function cascadeRect(index: number): WindowRect {
  const offset = index * 32;
  return { x: 24 + offset, y: 24 + offset, ...DEFAULT_WINDOW_SIZE };
}

export function resizeRect(
  rect: WindowRect,
  direction: ResizeDirection,
  delta: { readonly x: number; readonly y: number },
  viewport: Viewport,
): WindowRect {
  const fromLeft = direction.includes("left");
  const fromRight = direction.includes("right");
  const fromTop = direction.includes("top");
  const fromBottom = direction.includes("bottom");
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const width = fromLeft
    ? between(rect.width - delta.x, Math.min(MIN_WINDOW_SIZE.width, viewport.width), viewport.width)
    : fromRight
      ? between(
          rect.width + delta.x,
          Math.min(MIN_WINDOW_SIZE.width, viewport.width),
          viewport.width,
        )
      : rect.width;
  const height = fromTop
    ? between(
        rect.height - delta.y,
        Math.min(MIN_WINDOW_SIZE.height, viewport.height),
        viewport.height,
      )
    : fromBottom
      ? between(
          rect.height + delta.y,
          Math.min(MIN_WINDOW_SIZE.height, viewport.height),
          viewport.height,
        )
      : rect.height;

  return clampRect(
    {
      x: fromLeft ? right - width : rect.x,
      y: fromTop ? bottom - height : rect.y,
      width,
      height,
    },
    viewport,
  );
}

export function tileRects(count: number, viewport: Viewport): readonly WindowRect[] {
  if (count === 0) return [];

  const maxColumns = Math.max(1, Math.floor(viewport.width / MIN_WINDOW_SIZE.width));
  const columns = Math.min(Math.ceil(Math.sqrt(count)), maxColumns);
  const rows = Math.ceil(count / columns);
  const cellWidth = viewport.width / columns;
  const cellHeight = viewport.height / rows;

  return Array.from({ length: count }, (_, index) => ({
    x: (index % columns) * cellWidth,
    y: Math.floor(index / columns) * cellHeight,
    width: cellWidth,
    height: cellHeight,
  }));
}

export function snapRect(zone: SnapZone, viewport: Viewport): WindowRect {
  const width = viewport.width / 2;
  const quadrant = zone.includes("top") || zone.includes("bottom");
  const height = quadrant ? viewport.height / 2 : viewport.height;

  return {
    x: zone.includes("right") ? width : 0,
    y: zone.includes("bottom") ? height : 0,
    width,
    height,
  };
}

import {
  clampRect,
  cascadeRect,
  snapRect,
  tileRects,
  type SnapZone,
  type Viewport,
  type WindowRect,
} from "./window-geometry.js";

export interface ManagedWindow {
  readonly terminalId: number;
  readonly rect: WindowRect;
  readonly z: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly restoreRect?: WindowRect;
}

export interface WindowManagerView {
  readonly windows: readonly ManagedWindow[];
  readonly overview: boolean;
}

export interface RestoredWindowLayout {
  readonly terminalId: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly z: number;
  readonly state: "floating" | "minimized" | "maximized";
}

type Subscriber = (view: WindowManagerView) => void;

export class WindowManager {
  #viewport: Viewport;
  #windows: ManagedWindow[] = [];
  #overview = false;
  readonly #subscribers = new Set<Subscriber>();

  constructor({ viewport }: { readonly viewport: Viewport }) {
    this.#viewport = viewport;
  }

  restoreLayout(layouts: readonly RestoredWindowLayout[]): void {
    this.#windows = layouts.map((layout) => ({
      terminalId: layout.terminalId,
      rect: clampRect(
        { x: layout.x, y: layout.y, width: layout.width, height: layout.height },
        this.#viewport,
      ),
      z: layout.z,
      minimized: layout.state === "minimized",
      maximized: layout.state === "maximized",
    }));
    this.#publish();
  }

  reconcile(terminalIds: readonly number[]): void {
    const byId = new Map(this.#windows.map((window) => [window.terminalId, window]));
    this.#windows = terminalIds.map(
      (terminalId, index) =>
        byId.get(terminalId) ?? {
          terminalId,
          rect: clampRect(cascadeRect(index), this.#viewport),
          z: index + 1,
          minimized: false,
          maximized: false,
        },
    );
    this.#publish();
  }

  activate(terminalId: number): void {
    this.#raise(terminalId);
    this.#publish();
  }

  #raise(terminalId: number): void {
    const nextZ = Math.max(0, ...this.#windows.map((window) => window.z)) + 1;
    this.#windows = this.#windows.map((window) =>
      window.terminalId === terminalId ? { ...window, z: nextZ } : window,
    );
  }

  move(terminalId: number, position: Pick<WindowRect, "x" | "y">): void {
    this.#updateRect(terminalId, (rect) => ({ ...rect, ...position }));
    this.#publish();
  }

  resize(terminalId: number, size: Pick<WindowRect, "width" | "height">): void {
    this.#updateRect(terminalId, (rect) => ({ ...rect, ...size }));
    this.#publish();
  }

  minimize(terminalId: number): void {
    this.#windows = this.#windows.map((window) =>
      window.terminalId === terminalId ? { ...window, minimized: true } : window,
    );
    this.#publish();
  }

  maximize(terminalId: number): void {
    this.#windows = this.#windows.map((window) => {
      if (window.terminalId === terminalId) {
        return {
          ...window,
          rect: { x: 0, y: 0, ...this.#viewport },
          restoreRect: window.maximized ? window.restoreRect : window.rect,
          minimized: false,
          maximized: true,
        };
      }
      if (!window.maximized) return window;
      return {
        ...window,
        rect: window.restoreRect ?? window.rect,
        restoreRect: undefined,
        maximized: false,
      };
    });
    this.#raise(terminalId);
    this.#publish();
  }

  restore(terminalId: number): void {
    this.#windows = this.#windows.map((window) => {
      if (window.terminalId !== terminalId) return window;
      const rect = window.restoreRect ?? window.rect;
      const { restoreRect: _restoreRect, ...rest } = window;
      return { ...rest, rect, minimized: false, maximized: false };
    });
    this.#publish();
  }

  arrange(): void {
    const visible = this.#windows.filter((window) => !window.minimized);
    const tiles = tileRects(visible.length, this.#viewport);
    const tileById = new Map(
      visible.map((window, index) => [window.terminalId, tiles[index] as WindowRect]),
    );
    this.#windows = this.#windows.map((window) => {
      const rect = tileById.get(window.terminalId);
      return rect ? { ...window, rect, maximized: false, restoreRect: undefined } : window;
    });
    this.#publish();
  }

  snap(terminalId: number, zone: SnapZone): void {
    this.#windows = this.#windows.map((window) => {
      if (window.terminalId !== terminalId) return window;
      const { restoreRect: _restoreRect, ...rest } = window;
      return {
        ...rest,
        rect: snapRect(zone, this.#viewport),
        minimized: false,
        maximized: false,
      };
    });
    this.#raise(terminalId);
    this.#publish();
  }

  setViewport(viewport: Viewport): void {
    this.#viewport = viewport;
    this.#windows = this.#windows.map((window) => ({
      ...window,
      rect: window.maximized ? { x: 0, y: 0, ...viewport } : clampRect(window.rect, viewport),
      restoreRect: window.restoreRect ? clampRect(window.restoreRect, viewport) : undefined,
    }));
    this.#publish();
  }

  enterOverview(): void {
    this.#overview = true;
    this.#publish();
  }

  exitOverview(): void {
    this.#overview = false;
    this.#publish();
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  view(): WindowManagerView {
    return {
      windows: this.#windows.map((window) => ({
        ...window,
        rect: { ...window.rect },
        restoreRect: window.restoreRect ? { ...window.restoreRect } : undefined,
      })),
      overview: this.#overview,
    };
  }

  #updateRect(terminalId: number, update: (rect: WindowRect) => WindowRect): void {
    this.#windows = this.#windows.map((window) =>
      window.terminalId === terminalId
        ? { ...window, rect: clampRect(update(window.rect), this.#viewport) }
        : window,
    );
  }

  #publish(): void {
    const view = this.view();
    for (const subscriber of this.#subscribers) subscriber(view);
  }
}

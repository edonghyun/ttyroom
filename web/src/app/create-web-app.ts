import { createRoot } from "react-dom/client";
import { RoomApp, createProductionRoomRuntime, type RoomAppRuntime } from "./room-app.js";

import { createElement, type ReactNode } from "react";

export interface WebApp {
  dispose(): void;
}

export function createWebApp(options: {
  root: HTMLElement;
  content?: ReactNode;
  runtime?: RoomAppRuntime;
}): WebApp {
  const reactRoot = createRoot(options.root);
  const runtime = options.content ? null : (options.runtime ?? createProductionRoomRuntime());
  let disposed = false;

  reactRoot.render(options.content ?? (runtime ? createElement(RoomApp, { runtime }) : null));

  return {
    dispose(): void {
      if (disposed) return;

      disposed = true;
      reactRoot.unmount();
      runtime?.dispose();
    },
  };
}

import { createRoot } from "react-dom/client";

import type { ReactNode } from "react";

export interface WebApp {
  dispose(): void;
}

export function createWebApp(options: { root: HTMLElement; content: ReactNode }): WebApp {
  const reactRoot = createRoot(options.root);
  let disposed = false;

  reactRoot.render(options.content);

  return {
    dispose(): void {
      if (disposed) return;

      disposed = true;
      reactRoot.unmount();
    },
  };
}

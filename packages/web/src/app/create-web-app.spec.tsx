import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createWebApp } from "./create-web-app.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

describe("createWebApp — React application lifetime", () => {
  it("mounts the supplied application once and unmounts it on dispose", async () => {
    const root = document.createElement("div");

    const apps: Array<ReturnType<typeof createWebApp>> = [];
    await act(async () => {
      apps.push(createWebApp({ root, content: <main>TTYRoom</main> }));
    });

    expect(root).toHaveTextContent("TTYRoom");
    const app = apps[0];
    if (!app) throw new Error("Expected application to mount");

    await act(async () => app.dispose());

    expect(root).toBeEmptyDOMElement();
  });
});

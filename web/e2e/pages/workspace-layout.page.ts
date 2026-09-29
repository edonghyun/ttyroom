import { expect, type Locator, type Page } from "@playwright/test";
import type { RoomPage } from "./room.page.js";

type Rect = { x: number; y: number; width: number; height: number };

/** Pointer gestures and layout observations; no product expectation is supplied here. */
export class WorkspaceLayoutPage {
  constructor(
    private readonly page: Page,
    private readonly room: RoomPage,
  ) {}

  async beginMove(title: string, delta: { x: number; y: number }) {
    const bar = await bounds(this.room.terminal(title).locator(".terminal-titlebar"));
    await this.dragFrom({ x: bar.x + 80, y: bar.y + 18 }, delta);
  }

  async beginResize(title: string, delta: { width: number; height: number }) {
    const handle = await bounds(
      this.room.terminal(title).getByRole("button", { name: `Resize ${title}`, exact: true }),
    );
    await this.dragFrom(
      { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
      { x: delta.width, y: delta.height },
    );
  }

  private async dragFrom(start: { x: number; y: number }, delta: { x: number; y: number }) {
    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();
    await this.page.mouse.move(start.x + delta.x, start.y + delta.y);
  }

  async preview(title: string) {
    const ghost = this.page.locator(".window-interaction-ghost");
    await ghost.waitFor({ state: "visible" });
    return {
      label: await ghost.innerText(),
      ghost: await bounds(ghost),
      terminal: await this.room.terminalRect(title),
    };
  }

  async release() {
    await this.page.mouse.up();
    await this.page.locator(".window-interaction-ghost").waitFor({ state: "hidden" });
  }

  async panBy(delta: { x: number; y: number }) {
    await this.page.getByRole("button", { name: "Pan tool" }).click();
    const scene = await bounds(this.page.locator(".terminal-scene"));
    await this.dragFrom({ x: scene.x + scene.width - 10, y: scene.y + scene.height - 50 }, delta);
    await this.page.mouse.up();
    await this.page.getByRole("button", { name: "Select tool" }).click();
  }

  async floatingGeometry() {
    return this.page.locator(".terminal-window").evaluateAll((windows) =>
      windows.map((window) => {
        const { left, top, width, height } = (window as HTMLElement).style;
        return { left, top, width, height };
      }),
    );
  }

  async overviewBounds() {
    return this.page.locator(".terminal-window").evaluateAll((windows) =>
      windows.map((window) => {
        const { left, top, right, bottom } = window.getBoundingClientRect();
        return { left, top, right, bottom };
      }),
    );
  }

  async geometryMatching(title: string, expected: Rect) {
    let observed = await this.room.terminalRect(title);
    await expect
      .poll(async () => {
        observed = await this.room.terminalRect(title);
        return geometryDistance(observed, expected);
      })
      .toBeLessThan(2);
    return observed;
  }
}

export function geometryDistance(actual: Rect, expected: Rect) {
  return Math.max(
    ...(["x", "y", "width", "height"] as const).map((key) => Math.abs(actual[key] - expected[key])),
  );
}

async function bounds(locator: Locator): Promise<Rect> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`Visible geometry unavailable: ${locator}`);
  return rect;
}

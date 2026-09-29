import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const ARTIFACTS_DIR = resolve(
  WORKSPACE_ROOT,
  "artifacts/ui-operator/terminal-resize-close/screenshots/current/desktop",
);

let server: ViteDevServer;
let referenceUrl: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve(import.meta.dirname, "../../vite.visual.config.ts"),
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("visual server has no TCP address");
  referenceUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

test.afterAll(async () => {
  await server.close();
});

test("resizes from every side and removes a confirmed closed terminal window", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(referenceUrl);
  await page.evaluate(() => document.fonts.ready);

  const terminal = page.getByRole("group", { name: "backend terminal" });
  await expect(terminal).toBeVisible();
  await expect(terminal.locator(".resize-handle")).toHaveCount(8);
  await expectResizeCursors(terminal);

  const leftResize = await dragResize(
    page,
    terminal,
    "Resize backend from left",
    { x: 48, y: 0 },
    {
      x: 48,
      y: 0,
      width: -48,
      height: 0,
    },
  );
  await page.screenshot({
    path: resolve(ARTIFACTS_DIR, "room__left-resize-ghost.png"),
    animations: "disabled",
  });
  await page.mouse.up();
  await expectRect(terminal, leftResize.expected, "committed terminal");

  await dragAndCommit(
    page,
    terminal,
    "Resize backend from top",
    { x: 0, y: 24 },
    {
      x: 0,
      y: 24,
      width: 0,
      height: -24,
    },
  );
  await dragAndCommit(
    page,
    terminal,
    "Resize backend from right",
    { x: 32, y: 0 },
    {
      x: 0,
      y: 0,
      width: 32,
      height: 0,
    },
  );
  await dragAndCommit(
    page,
    terminal,
    "Resize backend from bottom",
    { x: 0, y: 28 },
    {
      x: 0,
      y: 0,
      width: 0,
      height: 28,
    },
  );

  await page.getByRole("button", { name: "Close backend" }).click();
  await expect(page.getByRole("alertdialog", { name: "Close backend?" })).toBeVisible();
  await page.getByRole("button", { name: "Close terminal" }).click();

  await expect(terminal).toBeHidden();
  await expect(page.locator(".terminal-window")).toHaveCount(4);
  await expect(page.locator(".dock-terminals > button:not(.add-terminal)")).toHaveCount(4);
  await page.screenshot({
    path: resolve(ARTIFACTS_DIR, "room__closed-window.png"),
    animations: "disabled",
  });
  expect(consoleErrors).toEqual([]);
});

async function dragAndCommit(
  page: Page,
  terminal: Locator,
  label: string,
  pointerDelta: { readonly x: number; readonly y: number },
  expectedDelta: Rect,
): Promise<void> {
  const resize = await dragResize(page, terminal, label, pointerDelta, expectedDelta);
  await page.mouse.up();
  await expectRect(terminal, resize.expected, "committed terminal");
}

async function dragResize(
  page: Page,
  terminal: Locator,
  label: string,
  pointerDelta: { readonly x: number; readonly y: number },
  expectedDelta: Rect,
): Promise<{ readonly expected: Rect }> {
  const handle = page.getByRole("button", { name: label, exact: true });
  const [before, handleBox] = await Promise.all([terminal.boundingBox(), handle.boundingBox()]);
  if (!before || !handleBox) throw new Error(`${label} is not visible`);
  const start = visibleHandlePoint(label, handleBox);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + pointerDelta.x, start.y + pointerDelta.y);

  const ghost = page.locator(".window-interaction-resize");
  await expect(ghost).toBeVisible();
  const expected = {
    x: before.x + expectedDelta.x,
    y: before.y + expectedDelta.y,
    width: before.width + expectedDelta.width,
    height: before.height + expectedDelta.height,
  };
  await expectRect(ghost, expected, "resize preview");
  await expect(terminal).toHaveAttribute("data-interacting", "resize");
  return { expected };
}

function visibleHandlePoint(label: string, box: Rect): { readonly x: number; readonly y: number } {
  const fromLeft = label.endsWith("left");
  const fromRight = label.endsWith("right") || label === "Resize backend";
  const fromTop = label.includes("from top");
  const fromBottom = label.includes("from bottom") || label === "Resize backend";
  return {
    x: fromLeft ? box.x + box.width - 2 : fromRight ? box.x + 2 : box.x + box.width / 2,
    y: fromTop ? box.y + box.height - 2 : fromBottom ? box.y + 2 : box.y + box.height / 2,
  };
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function expectRect(locator: Locator, expected: Rect, label: string): Promise<void> {
  await expect
    .poll(async () => {
      const actual = await locator.boundingBox();
      if (!actual) throw new Error(`${label} geometry is unavailable`);
      return Math.max(
        Math.abs(actual.x - expected.x),
        Math.abs(actual.y - expected.y),
        Math.abs(actual.width - expected.width),
        Math.abs(actual.height - expected.height),
      );
    })
    .toBeLessThan(1);
}

async function expectResizeCursors(terminal: Locator): Promise<void> {
  const expected = {
    top: "ns-resize",
    "top-right": "nesw-resize",
    right: "ew-resize",
    "bottom-right": "nwse-resize",
    bottom: "ns-resize",
    "bottom-left": "nesw-resize",
    left: "ew-resize",
    "top-left": "nwse-resize",
  } as const;
  for (const [direction, cursor] of Object.entries(expected)) {
    await expect(terminal.locator(`[data-resize-direction="${direction}"]`)).toHaveCSS(
      "cursor",
      cursor,
    );
  }
}

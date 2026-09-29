import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const ARTIFACTS_DIR = resolve(
  WORKSPACE_ROOT,
  "artifacts/ui-operator/workspace-boundary/screenshots/current/desktop-reference",
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

test("shows a finite workspace and lets terminals move across its expanded bounds", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1_125, height: 816 });
  await page.goto(referenceUrl);
  await page.evaluate(() => document.fonts.ready);

  const scene = page.locator(".terminal-scene");
  const surface = page.locator(".workspace-surface");
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  await zoomOut.click();
  await zoomOut.click();
  await zoomOut.click();
  await expect(page.getByRole("status", { name: "Canvas zoom" })).toHaveText("25%");

  await expect.poll(async () => surface.boundingBox()).toMatchObject({ width: 1_024, height: 576 });
  const backgrounds = await page.evaluate(() => ({
    outside: getComputedStyle(document.querySelector(".terminal-scene")!).backgroundColor,
    workspace: getComputedStyle(document.querySelector(".workspace-surface")!).backgroundColor,
  }));
  expect(backgrounds.outside).not.toBe(backgrounds.workspace);
  await scene.screenshot({
    path: resolve(ARTIFACTS_DIR, "room__zoomed-out-boundary.png"),
    animations: "disabled",
  });

  const terminal = page.getByRole("group", { name: "backend terminal" });
  const titlebar = terminal.locator(".terminal-titlebar");
  const titlebarBox = await titlebar.boundingBox();
  if (!titlebarBox) throw new Error("backend title bar is unavailable");
  await page.mouse.move(titlebarBox.x + 100, titlebarBox.y + titlebarBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(titlebarBox.x + 700, titlebarBox.y + titlebarBox.height / 2 + 200);
  await page.mouse.up();
  await expect
    .poll(() =>
      terminal.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)),
    )
    .toBeGreaterThan(2_000);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("status", { name: "Canvas zoom" })).toHaveText("50%");
  await page.getByRole("button", { name: "Pan tool" }).click();
  const sceneBox = await scene.boundingBox();
  if (!sceneBox) throw new Error("terminal scene is unavailable");
  await page.mouse.move(sceneBox.x + 220, sceneBox.y + 180);
  await page.mouse.down();
  await page.mouse.move(sceneBox.x + 1_020, sceneBox.y + 580);
  await page.mouse.up();

  const pannedSurface = await surface.boundingBox();
  if (!pannedSurface) throw new Error("workspace surface is unavailable");
  expect(pannedSurface.x).toBeCloseTo(sceneBox.x + 96, 0);
  expect(pannedSurface.y).toBeCloseTo(sceneBox.y + 96, 0);
  await scene.screenshot({
    path: resolve(ARTIFACTS_DIR, "room__panned-edge.png"),
    animations: "disabled",
  });
  expect(consoleErrors).toEqual([]);
});

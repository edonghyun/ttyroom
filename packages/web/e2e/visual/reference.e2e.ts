import { expect, test } from "@playwright/test";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");
const ARTIFACTS_DIR = resolve(WORKSPACE_ROOT, "artifacts/design-qa");
const SOURCE_IMAGE = resolve(
  WORKSPACE_ROOT,
  "docs/superpowers/specs/assets/ttyroom-floating-terminal-workspace.png",
);
const SOURCE_ARTIFACT = resolve(ARTIFACTS_DIR, "source-reference.png");
const IMPLEMENTATION_ARTIFACT = resolve(ARTIFACTS_DIR, "implementation-iteration-01.png");
const COMPARISON_ARTIFACT = resolve(ARTIFACTS_DIR, "iteration-01-comparison.png");

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
});

test.afterAll(async () => {
  await server.close();
});

test("reference room renders five production terminal surfaces with stable collaboration state", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(referenceUrl);

  await expect(page.getByText("Payment Debug", { exact: true })).toBeVisible();
  await expect(page.locator(".terminal-window")).toHaveCount(5);
  await expect(page.locator(".dock-terminals > button:not(.add-terminal)")).toHaveCount(5);
  await expect(page.locator(".terminal-window .xterm")).toHaveCount(5);

  await expect(page.getByRole("status", { name: "You control · Esc to release" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Minsu controls · View only" })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Read only · Remote input disabled" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch control to tests" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Jihun controls · View only" })).toBeVisible();

  await expect(page.getByLabel("backend output")).toContainText("Server listening");
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        horizontal: document.documentElement.scrollWidth - window.innerWidth,
        vertical: document.documentElement.scrollHeight - window.innerHeight,
      })),
    )
    .toEqual({ horizontal: 0, vertical: 0 });

  await page.getByRole("button", { name: "Open overview" }).click();
  await expect(page.getByRole("region", { name: "Terminal overview" })).toBeVisible();
  await expect(page.locator(".terminal-window .xterm")).toHaveCount(5);
  await page.getByRole("button", { name: "Exit Overview" }).click();
  await expect(page.getByRole("region", { name: "Terminal overview" })).toBeHidden();
  await expect(page.locator(".terminal-window .xterm")).toHaveCount(5);

  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await copyFile(SOURCE_IMAGE, SOURCE_ARTIFACT);
  await page.screenshot({ path: IMPLEMENTATION_ARTIFACT, animations: "disabled" });

  const [source, implementation] = await Promise.all([
    readFile(SOURCE_ARTIFACT, "base64"),
    readFile(IMPLEMENTATION_ARTIFACT, "base64"),
  ]);
  const comparisonPage = await page.context().newPage();
  await comparisonPage.setViewportSize({ width: 2974, height: 1058 });
  await comparisonPage.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 2974px; height: 1058px; overflow: hidden; background: #000; }
      main { display: flex; width: 2974px; height: 1058px; }
      img { display: block; flex: none; width: 1487px; height: 1058px; max-width: none; }
    </style>
    <main aria-label="Source and implementation comparison">
      <img alt="Source reference" src="data:image/png;base64,${source}" />
      <img alt="Implementation" src="data:image/png;base64,${implementation}" />
    </main>
  `);
  await expect(comparisonPage.getByAltText("Source reference")).toHaveJSProperty(
    "naturalWidth",
    1487,
  );
  await expect(comparisonPage.getByAltText("Implementation")).toHaveJSProperty(
    "naturalWidth",
    1487,
  );
  await comparisonPage.screenshot({ path: COMPARISON_ARTIFACT, animations: "disabled" });
  await comparisonPage.close();

  await page.getByRole("button", { name: "Open backend menu" }).click();
  await expect(page.getByRole("menu", { name: "backend actions" })).toBeVisible();
  await page.getByRole("button", { name: "Add host" }).click();
  await expect(page.getByRole("dialog", { name: "Add Host" })).toBeVisible();
  await page.getByRole("button", { name: "Close Add Host" }).click();
  await expect(page.getByRole("dialog", { name: "Add Host" })).toBeHidden();
  expect(consoleErrors).toEqual([]);
});

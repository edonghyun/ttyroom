import { expect, test, type Page } from "@playwright/test";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const ARTIFACTS_DIR = resolve(WORKSPACE_ROOT, "artifacts/design-qa");
const SOURCE_IMAGE = resolve(
  WORKSPACE_ROOT,
  "docs/superpowers/specs/assets/ttyroom-floating-terminal-workspace.png",
);
const SOURCE_ARTIFACT = resolve(ARTIFACTS_DIR, "source-reference.png");
const FINAL_IMPLEMENTATION_ARTIFACT = resolve(ARTIFACTS_DIR, "implementation-final.png");
const FINAL_COMPARISON_ARTIFACT = resolve(ARTIFACTS_DIR, "final-comparison.png");

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
  await expect
    .poll(() =>
      page.evaluate(() => {
        const terminal = document.querySelector<HTMLElement>(
          '.terminal-window[data-terminal-id="1"]',
        );
        const titlebar = terminal?.querySelector<HTMLElement>(".terminal-titlebar");
        const status = terminal?.querySelector<HTMLElement>(".terminal-status");
        const action = terminal?.querySelector<HTMLButtonElement>(".window-actions button");
        const takeControl = document.querySelector<HTMLButtonElement>(".take-control");
        return {
          titlebarHeight: titlebar?.getBoundingClientRect().height ?? 0,
          statusHeight: status?.getBoundingClientRect().height ?? 0,
          actionHeight: action?.getBoundingClientRect().height ?? 0,
          takeControlHeight: takeControl?.getBoundingClientRect().height ?? 0,
        };
      }),
    )
    .toEqual({
      titlebarHeight: 42,
      statusHeight: 26,
      actionHeight: 26,
      takeControlHeight: 26,
    });
  await expect
    .poll(() =>
      page.locator(".dock").evaluate((dock) => ({
        dockHeight: dock.getBoundingClientRect().height,
        terminalButtonHeight:
          dock.querySelector<HTMLButtonElement>(".dock-terminals > button")?.getBoundingClientRect()
            .height ?? 0,
      })),
    )
    .toEqual({ dockHeight: 48, terminalButtonHeight: 36 });
  await expect(page.locator(".add-terminal")).toHaveCSS("white-space", "nowrap");

  await expect(page.getByRole("status", { name: "You control · Esc to release" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Minsu controls · View only" })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Read only · Remote input disabled" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch control to tests" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Jihun controls · View only" })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("status", { name: "You control · Esc to release" })
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .not.toBe("rgba(0, 0, 0, 0)");
  await expect
    .poll(() =>
      page
        .getByRole("button", { name: "Arrange terminals" })
        .evaluate((element) => getComputedStyle(element).borderTopStyle),
    )
    .toBe("solid");

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
  await page.screenshot({ path: FINAL_IMPLEMENTATION_ARTIFACT, animations: "disabled" });

  const [source, implementation] = await Promise.all([
    readFile(SOURCE_ARTIFACT, "base64"),
    readFile(FINAL_IMPLEMENTATION_ARTIFACT, "base64"),
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
  await comparisonPage.screenshot({ path: FINAL_COMPARISON_ARTIFACT, animations: "disabled" });
  await comparisonPage.close();

  await Promise.all([
    captureFocusedComparison(page, source, implementation, "top-bar", {
      x: 0,
      y: 0,
      width: 1487,
      height: 110,
    }),
    captureFocusedComparison(page, source, implementation, "backend-header-status", {
      x: 40,
      y: 45,
      width: 740,
      height: 120,
    }),
    captureFocusedComparison(page, source, implementation, "tests-take-control", {
      x: 20,
      y: 600,
      width: 500,
      height: 270,
    }),
    captureFocusedComparison(page, source, implementation, "dock-participants", {
      x: 0,
      y: 914,
      width: 1487,
      height: 144,
    }),
  ]);

  await page.getByRole("button", { name: "Open backend menu" }).click();
  await expect(page.getByRole("menu", { name: "backend actions" })).toBeVisible();
  await page.getByRole("button", { name: "Open room menu" }).click();
  await page.getByRole("menuitem", { name: "Add host" }).click();
  await expect(page.getByRole("dialog", { name: "Add Host" })).toBeVisible();
  await page.getByRole("button", { name: "Close Add Host" }).click();
  await expect(page.getByRole("dialog", { name: "Add Host" })).toBeHidden();
  expect(consoleErrors).toEqual([]);

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ]) {
    const responsivePage = await page.context().newPage();
    await responsivePage.setViewportSize(viewport);
    await responsivePage.goto(referenceUrl);
    await expect(responsivePage.locator(".terminal-window .xterm")).toHaveCount(5);
    await expect(responsivePage.getByLabel("backend output")).toContainText("Server listening");
    await expect(responsivePage.getByText("Control acquired · backend")).toBeVisible();
    await responsivePage.evaluate(() => document.fonts.ready);
    await expect
      .poll(() =>
        responsivePage.locator(".terminal-window .xterm").evaluateAll((terminals) =>
          terminals.every((terminal) => {
            const rows = terminal.querySelector(".xterm-rows");
            const rect = terminal.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (rows?.textContent?.length ?? 0) > 0;
          }),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        responsivePage.evaluate(() => ({
          horizontal: document.documentElement.scrollWidth - window.innerWidth,
          vertical: document.documentElement.scrollHeight - window.innerHeight,
        })),
      )
      .toEqual({ horizontal: 0, vertical: 0 });
    await responsivePage.screenshot({
      path: resolve(ARTIFACTS_DIR, `responsive-${viewport.width}x${viewport.height}.png`),
      animations: "disabled",
    });
    await responsivePage.close();
  }
});

async function captureFocusedComparison(
  page: Page,
  source: string,
  implementation: string,
  name: string,
  crop: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const focusedPage = await page.context().newPage();
  await focusedPage.setViewportSize({ width: crop.width * 2, height: crop.height });
  await focusedPage.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: ${crop.width * 2}px; height: ${crop.height}px; overflow: hidden; background: #000; }
      main { display: flex; }
      .crop { position: relative; flex: none; width: ${crop.width}px; height: ${crop.height}px; overflow: hidden; }
      img { position: absolute; left: -${crop.x}px; top: -${crop.y}px; width: 1487px; height: 1058px; max-width: none; }
    </style>
    <main aria-label="Focused source and implementation comparison">
      <div class="crop"><img alt="Source crop" src="data:image/png;base64,${source}" /></div>
      <div class="crop"><img alt="Implementation crop" src="data:image/png;base64,${implementation}" /></div>
    </main>
  `);
  await expect(focusedPage.getByAltText("Source crop")).toHaveJSProperty("naturalWidth", 1487);
  await expect(focusedPage.getByAltText("Implementation crop")).toHaveJSProperty(
    "naturalWidth",
    1487,
  );
  await focusedPage.screenshot({
    path: resolve(ARTIFACTS_DIR, `focused-${name}-comparison.png`),
    animations: "disabled",
  });
  await focusedPage.close();
}

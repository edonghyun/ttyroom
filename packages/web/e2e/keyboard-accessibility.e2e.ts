import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/actors.js";

test("Tab and Shift+Tab navigate room, window, and Dock without acquiring control", async ({
  alice,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  const terminal = alice.roomPage.terminal("term-1");

  await alice.page.getByRole("button", { name: "Open room menu" }).focus();
  await alice.page.keyboard.press("Tab");
  await expect(terminal).toBeFocused();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  expect(await terminal.evaluate((element) => element.matches(":focus-visible"))).toBe(true);

  await alice.page.getByRole("button", { name: "Add terminal" }).focus();
  await alice.page.keyboard.press("Shift+Tab");
  await expect(alice.page.getByRole("button", { name: "Focus term-1" })).toBeFocused();
  await alice.page.keyboard.press("Tab");
  await expect(alice.page.getByRole("button", { name: "Add terminal" })).toBeFocused();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
});

test("Tab is delivered to the remote PTY as the shell completion byte", async ({ alice }) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");

  await alice.roomPage.typeInTerminal(
    "term-1",
    "printf '\\124\\101\\102\\137\\122\\105\\101\\104\\131'; IFS= read -rk 1 key; printf '\\n\\124\\101\\102\\137\\102\\131\\124\\105:'; printf '%s' \"$key\" | od -An -tx1",
  );
  await expect.poll(() => alice.roomPage.terminalText("term-1")).toContain("TAB_READY");
  await alice.page.keyboard.press("Tab");
  await expect.poll(() => alice.roomPage.terminalText("term-1")).toMatch(/TAB_BYTE:\s+09/);
});

test("window focus and terminal input focus remain visibly distinct", async ({ alice }) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");
  const terminal = alice.roomPage.terminal("term-1");

  await alice.page.getByRole("button", { name: "Open room menu" }).focus();
  await alice.page.keyboard.press("Tab");
  await expect(terminal).toBeFocused();
  expect(await terminal.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    "none",
  );

  await terminal.getByLabel("term-1 output").click();
  await expect(terminal.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  expect(
    await terminal
      .getByLabel("term-1 output")
      .evaluate((element) => element.matches(":focus-within")),
  ).toBe(true);
  expect(await terminal.evaluate((element) => getComputedStyle(element).boxShadow)).toContain(
    "rgb(117, 214, 182)",
  );
  expect(
    await terminal
      .getByLabel("term-1 output")
      .evaluate((element) => getComputedStyle(element).boxShadow),
  ).not.toContain("rgb(117, 214, 182)");
  await expect(terminal).toHaveAttribute("aria-current", "true");
});

test("modal focus is trapped and Escape closes the modal before releasing control", async ({
  alice,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");
  await alice.page.getByRole("button", { name: "Open room menu" }).click();
  await alice.page.getByRole("menuitem", { name: "Add host" }).click();
  const dialog = alice.page.getByRole("dialog", { name: "Add Host" });
  const close = dialog.getByRole("button", { name: "Close Add Host" });
  const copy = dialog.getByRole("button", { name: "Copy command" });
  await expect(close).toBeFocused();
  await alice.page.keyboard.press("Shift+Tab");
  await expect(copy).toBeFocused();
  await alice.page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await alice.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(alice.page.getByRole("button", { name: "Open room menu" })).toBeFocused();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );

  await alice.page.keyboard.press("Escape");
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
});

test("Overview can be entered and a terminal selected entirely from the keyboard", async ({
  alice,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal("term-1");
  await alice.roomPage.openTerminal("term-2");

  await alice.page.keyboard.press("Alt+o");
  const overview = alice.page.getByRole("region", { name: "Terminal overview" });
  await expect(overview).toBeVisible();
  await alice.roomPage.terminal("term-2").focus();
  await alice.page.keyboard.press("Enter");

  await expect(overview).toBeHidden();
  await expect(alice.roomPage.terminal("term-2")).toHaveAttribute("aria-current", "true");
});

test("terminal status exposes an icon, visible text, and an accessible name", async ({ alice }) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  const status = alice.roomPage.terminalStatus("term-1");

  await expect(status).toHaveAccessibleName("Available");
  await expect(status.getByText("Available")).toBeVisible();
  await expect(status.locator("svg")).toHaveAttribute("aria-hidden", "true");
});

test("live collaboration workspace has no serious or critical axe violations", async ({
  alice,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");

  const results = await new AxeBuilder({ page: alice.page }).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blocking).toEqual([]);
});

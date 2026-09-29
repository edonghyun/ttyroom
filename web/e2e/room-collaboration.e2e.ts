import { expect, test } from "./fixtures/actors.js";
import { givenTwoParticipantsWithTerminal } from "./fixtures/workspace.js";
import { sampleCursorMotion } from "./fixtures/cursor-motion.js";
import { RoomPage } from "./pages/room.page.js";
import { WorkspaceLayoutPage, geometryDistance } from "./pages/workspace-layout.page.js";
import type { BrowserParticipantActor } from "./fixtures/participant-actor.js";

test("terminal title bars show each participant's current focus and tooltip", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);
  await alice.roomPage.openTerminal("term-2");
  const initialFocus = alice.roomPage.terminal("term-2").getByLabel("Focused by You, Bob");
  await initialFocus.waitFor({ state: "visible" });
  const initiallyTogether = await initialFocus.isVisible();

  await bob.roomPage
    .terminal("term-1")
    .locator(".terminal-titlebar")
    .click({ position: { x: 80, y: 18 } });
  const bobBadge = alice.roomPage.terminal("term-1").getByLabel("Focused by Bob");
  await bobBadge.hover();

  expect(initiallyTogether).toBe(true);
  await expect(bobBadge).toBeVisible();
  await expect(alice.roomPage.terminal("term-2").getByLabel("Focused by You")).toBeVisible();
  await expect(alice.roomPage.terminal("term-1").getByRole("tooltip")).toHaveText("Bob");
});

test("participant cursor motion is visible remotely and disappears after leaving the canvas", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();

  const motion = await sampleCursorMotion(alice, bob);
  await alice.page.mouse.move(8, 8);

  expect(motion.ownCursorCount).toBe(0);
  expect(new Set(motion.transforms).size).toBeGreaterThan(10);
  await expect(bob.page.getByLabel("Alice cursor")).toBeHidden();
});

test("a duplicated tab joins independently without reconnect contention", async ({ alice }) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.recordConnectionStates();
  const originalClientId = await alice.clientId();

  const duplicatePromise = alice.context.waitForEvent("page");
  await alice.page.evaluate(() => window.open(location.href, "_blank"));
  const duplicate = await duplicatePromise;
  try {
    const duplicateRoom = new RoomPage(duplicate);
    await duplicate
      .getByRole("region", { name: "Terminal workspace" })
      .waitFor({ state: "visible" });
    await duplicateRoom.recordConnectionStates();
    const duplicateClientId = await duplicateRoom.clientId();
    // Observe the original contention window as well as successful bidirectional use.
    await duplicate.waitForTimeout(1_200);
    const originalStates = await alice.roomPage.recordedConnectionStates();
    const duplicateStates = await duplicateRoom.recordedConnectionStates();
    await alice.roomPage.takeControl("term-1");
    await alice.roomPage.printLine("term-1", "DUPLICATE_TAB_OUTPUT");
    const originalOutput = await alice.roomPage.outputContaining("term-1", "DUPLICATE_TAB_OUTPUT");
    const duplicateOutput = await duplicateRoom.outputContaining("term-1", "DUPLICATE_TAB_OUTPUT");

    expect(duplicateClientId).not.toBe(originalClientId);
    expect(originalStates).toEqual(["Connected"]);
    expect(duplicateStates).toEqual(["Connected"]);
    await expect(alice.roomPage.terminal("term-1")).toBeVisible();
    await expect(duplicateRoom.terminal("term-1")).toBeVisible();
    expect(originalOutput).toContain("DUPLICATE_TAB_OUTPUT");
    expect(duplicateOutput).toContain("DUPLICATE_TAB_OUTPUT");
  } finally {
    await duplicate.close();
  }
});

test("refresh rejoins with the saved nickname without showing the join form", async ({ alice }) => {
  await alice.joinRoom();
  const clientId = await alice.clientId();

  await alice.page.reload();

  await expect(alice.page.getByRole("region", { name: "Terminal workspace" })).toBeVisible();
  await expect(alice.page.getByRole("textbox", { name: "Nickname" })).toHaveCount(0);
  expect(await alice.clientId()).toBe(clientId);
});

test("drag preview follows the pointer while geometry commits only on release", async ({
  alice,
}) => {
  const layout = await givenTerminalLayout(alice);
  const before = await alice.roomPage.terminalRect("term-1");

  await layout.beginMove("term-1", { x: 80, y: 50 });
  const preview = await layout.preview("term-1");
  await layout.release();
  const after = await alice.roomPage.terminalRect("term-1");

  expect(preview.label).toContain("Moving");
  expect(preview.terminal).toEqual(before);
  expect(preview.ghost.x).toBeCloseTo(before.x + 80, 0);
  expect(preview.ghost.y).toBeCloseTo(before.y + 50, 0);
  expect(after.x).toBeCloseTo(before.x + 80, 0);
  expect(after.y).toBeCloseTo(before.y + 50, 0);
});

test("resize preview follows the pointer while geometry commits only on release", async ({
  alice,
}) => {
  const layout = await givenTerminalLayout(alice);
  await alice.roomPage.moveTerminal("term-1", { x: 80, y: 50 });
  const before = await alice.roomPage.terminalRect("term-1");

  await layout.beginResize("term-1", { width: 70, height: 45 });
  const preview = await layout.preview("term-1");
  await layout.release();
  const after = await alice.roomPage.terminalRect("term-1");

  expect(preview.label).toContain("Resizing");
  expect(preview.terminal).toEqual(before);
  expect(preview.ghost.width).toBeCloseTo(before.width + 70, 0);
  expect(preview.ghost.height).toBeCloseTo(before.height + 45, 0);
  expect(after.width).toBeCloseTo(before.width + 70, 0);
  expect(after.height).toBeCloseTo(before.height + 45, 0);
});

test("terminal geometry stays synchronized before and after participant reload", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);
  const peerLayout = new WorkspaceLayoutPage(bob.page, bob.roomPage);

  await alice.roomPage.moveTerminal("term-1", { x: 96, y: 54 });
  await alice.roomPage.resizeTerminal("term-1", { width: 72, height: 46 });
  const expected = await alice.roomPage.terminalRect("term-1");
  const live = await peerLayout.geometryMatching("term-1", expected);
  await bob.reloadRoom();
  const restored = await peerLayout.geometryMatching("term-1", expected);

  expect(geometryDistance(live, expected)).toBeLessThan(2);
  expect(geometryDistance(restored, expected)).toBeLessThan(2);
});

test("terminal names stay synchronized before and after participant reload", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);

  await alice.roomPage.renameTerminal("term-1", "API logs");
  await bob.roomPage.terminal("API logs").waitFor({ state: "visible" });
  const visibleBeforeReload = await bob.roomPage.terminal("API logs").isVisible();
  const oldPeerNameCount = await bob.roomPage.terminal("term-1").count();
  await bob.reloadRoom();

  expect(visibleBeforeReload).toBe(true);
  expect(oldPeerNameCount).toBe(0);
  await expect(alice.roomPage.terminal("API logs")).toBeVisible();
  await expect(alice.roomPage.terminal("term-1")).toHaveCount(0);
  await expect(bob.roomPage.terminal("API logs")).toBeVisible();
});

for (const menu of [
  { button: "Open room menu", name: "Room menu" },
  { button: "Open term-1 menu", name: "term-1 actions" },
]) {
  test(`${menu.name} closes when the user clicks elsewhere`, async ({ alice }) => {
    await givenTerminalLayout(alice);

    await alice.page.getByRole("button", { name: menu.button }).click();
    const openedMenu = alice.page.getByRole("menu", { name: menu.name });
    await openedMenu.waitFor({ state: "visible" });
    const wasOpen = await openedMenu.isVisible();
    await alice.page.locator(".terminal-scene").click({ position: { x: 900, y: 500 } });

    expect(wasOpen).toBe(true);
    await expect(openedMenu).toBeHidden();
  });
}

test("an empty workspace guides the first terminal", async ({ alice }) => {
  await alice.joinRoom();

  await expect(alice.page.getByRole("heading", { name: "Open your first terminal" })).toBeVisible();
  await expect(
    alice.page.getByRole("button", { name: "Open terminal on real-host" }),
  ).toBeVisible();
});

test("the host drawer shows the connection command and confirms its copy", async ({ alice }) => {
  await alice.joinRoom();
  await alice.context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await alice.page.getByRole("button", { name: "Open room menu" }).click();
  await alice.page.getByRole("menuitem", { name: "Add host" }).click();
  const drawer = alice.page.getByRole("dialog", { name: "Add Host" });
  await drawer.getByRole("button", { name: "Copy command" }).click();

  await expect(drawer.getByText("Run the host command")).toBeVisible();
  await expect(drawer.getByLabel("Host connection command")).toContainText(
    "node connector/dist/index.js join",
  );
  await expect(drawer.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await alice.page.evaluate(() => navigator.clipboard.readText())).toBe(
    await drawer.getByLabel("Host connection command").innerText(),
  );
});

test("canvas zoom and pan preserve terminal interaction coordinates", async ({ alice }) => {
  const layout = await givenTerminalLayout(alice);
  const before = await alice.roomPage.terminalRect("term-1");

  await alice.page.getByRole("button", { name: "Zoom out" }).click();
  const zoomLabel = await alice.page.getByRole("status", { name: "Canvas zoom" }).innerText();
  const zoomed = await alice.roomPage.terminalRect("term-1");
  await layout.panBy({ x: -70, y: -40 });
  const panned = await alice.roomPage.terminalRect("term-1");
  await layout.beginMove("term-1", { x: 75, y: 30 });
  await layout.release();
  const moved = await alice.roomPage.terminalRect("term-1");
  await alice.page.getByRole("button", { name: "Reset zoom to 100%" }).click();

  expect(zoomLabel).toBe("75%");
  expect(zoomed.width).toBeCloseTo(before.width * 0.75, 0);
  expect(zoomed.height).toBeCloseTo(before.height * 0.75, 0);
  expect(panned.x).toBeCloseTo(zoomed.x - 70, 0);
  expect(panned.y).toBeCloseTo(zoomed.y - 40, 0);
  expect(moved.x).toBeCloseTo(panned.x + 75, 0);
  expect(moved.y).toBeCloseTo(panned.y + 30, 0);
  await expect(alice.page.getByRole("status", { name: "Canvas zoom" })).toHaveText("100%");
});

test("cancelling a terminal close preserves it", async ({ alice, bob }) => {
  await givenTwoParticipantsWithTerminal(alice, bob);

  await alice.roomPage.requestClose("term-1");
  await alice.roomPage.closeDialog().waitFor({ state: "visible" });
  await alice.roomPage.cancelClose();

  await expect(alice.roomPage.terminal("term-1")).toBeVisible();
});

test("confirmed close removes the local window and lets peers dismiss the exited terminal", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);

  await alice.roomPage.requestClose("term-1");
  await alice.roomPage.confirmClose();
  const exited = bob.roomPage.terminalStatus("term-1");
  await expect(exited).toHaveAccessibleName(/Exited/);
  const peerExitStatus = await exited.getAttribute("aria-label");
  await bob.roomPage.requestClose("term-1");

  expect(peerExitStatus).toMatch(/Exited/);
  await expect(alice.roomPage.terminal("term-1")).toHaveCount(0);
  await expect(bob.roomPage.closeDialog()).toHaveCount(0);
  await expect(bob.roomPage.terminal("term-1")).toHaveCount(0);
});

test("minimize is participant-local and the dock reflects each participant's state", async ({
  alice,
  bob,
}) => {
  await givenFiveTerminals(alice, bob);

  await alice.roomPage.minimize("term-1");

  await expect(alice.roomPage.dockTerminals()).toHaveCount(5);
  await expect(bob.roomPage.dockTerminals()).toHaveCount(5);
  await expect(alice.roomPage.terminal("term-1")).toBeHidden();
  await expect(alice.page.getByRole("button", { name: "Restore term-1" })).toBeVisible();
  await expect(bob.roomPage.terminal("term-1")).toBeVisible();
  await expect(bob.page.getByRole("button", { name: "Focus term-1" })).toBeVisible();
});

test("Overview avoids overlap and restores floating geometry and minimized state", async ({
  alice,
  bob,
}) => {
  await givenFiveTerminals(alice, bob);
  await alice.roomPage.minimize("term-1");
  const layout = new WorkspaceLayoutPage(alice.page, alice.roomPage);
  const floating = await layout.floatingGeometry();

  await alice.roomPage.enterOverview();
  const visible = [];
  for (let id = 1; id <= 5; id++)
    visible.push(await alice.roomPage.terminal(`term-${id}`).isVisible());
  const boxes = await layout.overviewBounds();
  await alice.roomPage.exitOverview();

  expect(visible).toEqual([true, true, true, true, true]);
  expectNoOverlappingWindows(boxes);
  await expect.poll(() => layout.floatingGeometry()).toEqual(floating);
  await expect(alice.roomPage.terminal("term-1")).toBeHidden();
});

async function givenTerminalLayout(alice: BrowserParticipantActor) {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  return new WorkspaceLayoutPage(alice.page, alice.roomPage);
}

async function givenFiveTerminals(alice: BrowserParticipantActor, bob: BrowserParticipantActor) {
  await givenTwoParticipantsWithTerminal(alice, bob);
  for (let id = 2; id <= 5; id++) await alice.roomPage.openTerminal(`term-${id}`);
  await expect(alice.roomPage.dockTerminals()).toHaveCount(5);
  await expect(bob.roomPage.dockTerminals()).toHaveCount(5);
}

function expectNoOverlappingWindows(
  boxes: Array<{ left: number; top: number; right: number; bottom: number }>,
) {
  const overlaps = boxes.flatMap((candidate, index) =>
    boxes
      .slice(index + 1)
      .filter(
        (other) =>
          candidate.left < other.right &&
          candidate.right > other.left &&
          candidate.top < other.bottom &&
          candidate.bottom > other.top,
      ),
  );
  expect(overlaps).toEqual([]);
}

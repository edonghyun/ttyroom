import { expect, test } from "./fixtures/actors.js";

test("two participants explicitly take control and share real PTY output", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();

  await alice.roomPage.openTerminal();
  await expect(alice.roomPage.terminal("term-1")).toContainText("real-host");
  await expect(bob.roomPage.terminal("term-1")).toBeVisible();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");

  await alice.roomPage.takeControl("term-1");
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "Alice controls · View only",
  );
  const toast = alice.page.getByText("Control acquired · term-1", { exact: true });
  await expect(toast).toBeVisible();
  const toastBox = await toast.boundingBox();
  const canvasControlsBox = await alice.page
    .getByRole("navigation", { name: "Canvas controls" })
    .boundingBox();
  if (!toastBox || !canvasControlsBox) throw new Error("feedback geometry is unavailable");
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(canvasControlsBox.y - 8);

  const marker = `TTYROOM_E2E_${Date.now()}`;
  await alice.roomPage.typeInTerminal("term-1", `printf '${marker}\\n'`);
  await expect.poll(() => alice.roomPage.terminalText("term-1")).toContain(marker);
  await expect.poll(() => bob.roomPage.terminalText("term-1")).toContain(marker);
});

test("selecting another participant's terminal neither acquires nor sends input", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "Alice controls · View only",
  );

  const rejectedMarker = `BOB_MUST_NOT_SEND_${Date.now()}`;
  await bob.roomPage.typeInTerminal("term-1", `printf '${rejectedMarker}\\n'`);
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "Alice controls · View only",
  );

  const synchronizationMarker = `ALICE_AFTER_BOB_${Date.now()}`;
  await alice.roomPage.typeInTerminal("term-1", `printf '${synchronizationMarker}\\n'`);
  await expect.poll(() => bob.roomPage.terminalText("term-1")).toContain(synchronizationMarker);
  expect(await alice.roomPage.terminalText("term-1")).not.toContain(rejectedMarker);
  expect(await bob.roomPage.terminalText("term-1")).not.toContain(rejectedMarker);
});

test("terminal title bars show who currently has each terminal focused", async ({ alice, bob }) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal("term-1");
  await alice.roomPage.openTerminal("term-2");

  await expect(alice.roomPage.terminal("term-2").getByLabel("Focused by You, Bob")).toBeVisible();

  await bob.roomPage
    .terminal("term-1")
    .locator(".terminal-titlebar")
    .click({ position: { x: 8, y: 8 } });
  const bobBadge = alice.roomPage.terminal("term-1").getByLabel("Focused by Bob");
  await expect(bobBadge).toBeVisible();
  await expect(alice.roomPage.terminal("term-2").getByLabel("Focused by You")).toBeVisible();

  await bobBadge.hover();
  await expect(alice.roomPage.terminal("term-1").getByRole("tooltip")).toHaveText("Bob");
});

test("dragging and resizing show a pointer-following ghost before committing geometry", async ({
  alice,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal("term-1");
  const terminal = alice.roomPage.terminal("term-1");
  const titlebar = terminal.locator(".terminal-titlebar");
  const beforeMove = await terminal.boundingBox();
  const titlebarBox = await titlebar.boundingBox();
  if (!beforeMove || !titlebarBox) throw new Error("terminal geometry is unavailable");

  await alice.page.mouse.move(titlebarBox.x + 80, titlebarBox.y + 18);
  await alice.page.mouse.down();
  await alice.page.mouse.move(titlebarBox.x + 160, titlebarBox.y + 68);

  const moveGhost = alice.page.locator(".window-interaction-ghost");
  await expect(moveGhost).toBeVisible();
  await expect(moveGhost).toContainText("Moving");
  expect(await terminal.boundingBox()).toEqual(beforeMove);
  const moveGhostBox = await moveGhost.boundingBox();
  expect(moveGhostBox?.x).toBeCloseTo(beforeMove.x + 80, 0);
  expect(moveGhostBox?.y).toBeCloseTo(beforeMove.y + 50, 0);

  await alice.page.mouse.up();
  await expect(moveGhost).toBeHidden();
  const moved = await terminal.boundingBox();
  expect(moved?.x).toBeCloseTo(beforeMove.x + 80, 0);
  expect(moved?.y).toBeCloseTo(beforeMove.y + 50, 0);
  if (!moved) throw new Error("moved terminal geometry is unavailable");

  const resizeHandle = terminal.getByRole("button", { name: "Resize term-1" });
  const handleBox = await resizeHandle.boundingBox();
  if (!handleBox) throw new Error("resize handle geometry is unavailable");
  await alice.page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await alice.page.mouse.down();
  await alice.page.mouse.move(
    handleBox.x + handleBox.width / 2 + 70,
    handleBox.y + handleBox.height / 2 + 45,
  );

  const resizeGhost = alice.page.locator(".window-interaction-resize");
  await expect(resizeGhost).toBeVisible();
  await expect(resizeGhost).toContainText("Resizing");
  expect(await terminal.boundingBox()).toEqual(moved);
  const resizeGhostBox = await resizeGhost.boundingBox();
  expect(resizeGhostBox?.width).toBeCloseTo(moved.width + 70, 0);
  expect(resizeGhostBox?.height).toBeCloseTo(moved.height + 45, 0);

  await alice.page.mouse.up();
  await expect(resizeGhost).toBeHidden();
  const resized = await terminal.boundingBox();
  expect(resized?.width).toBeCloseTo(moved.width + 70, 0);
  expect(resized?.height).toBeCloseTo(moved.height + 45, 0);
});

test("terminal geometry stays synchronized for present and reconnecting participants", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal("term-1");

  await alice.roomPage.moveTerminal("term-1", { x: 96, y: 54 });
  await alice.roomPage.resizeTerminal("term-1", { width: 72, height: 46 });
  const aliceRect = await alice.roomPage.terminalRect("term-1");
  const geometryDelta = async () => {
    const bobRect = await bob.roomPage.terminalRect("term-1");
    return Math.max(
      Math.abs(aliceRect.x - bobRect.x),
      Math.abs(aliceRect.y - bobRect.y),
      Math.abs(aliceRect.width - bobRect.width),
      Math.abs(aliceRect.height - bobRect.height),
    );
  };

  await expect.poll(geometryDelta).toBeLessThan(2);
  await bob.reloadRoom();
  await expect.poll(geometryDelta).toBeLessThan(2);
});

test("terminal names stay synchronized for present and reconnecting participants", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal("term-1");

  await alice.roomPage.renameTerminal("term-1", "API logs");

  await expect(alice.roomPage.terminal("API logs")).toBeVisible();
  await expect(bob.roomPage.terminal("API logs")).toBeVisible();
  await expect(alice.roomPage.terminal("term-1")).toHaveCount(0);
  await expect(bob.roomPage.terminal("term-1")).toHaveCount(0);

  await bob.reloadRoom();
  await expect(bob.roomPage.terminal("API logs")).toBeVisible();
});

test("canvas controls zoom, pan, and preserve terminal interaction coordinates", async ({
  alice,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal("term-1");
  const terminal = alice.roomPage.terminal("term-1");
  const before = await terminal.boundingBox();
  if (!before) throw new Error("terminal geometry is unavailable");

  await alice.page.getByRole("button", { name: "Zoom out" }).click();
  await expect(alice.page.getByRole("status", { name: "Canvas zoom" })).toHaveText("75%");
  const zoomed = await terminal.boundingBox();
  expect(zoomed?.width).toBeCloseTo(before.width * 0.75, 0);
  expect(zoomed?.height).toBeCloseTo(before.height * 0.75, 0);
  if (!zoomed) throw new Error("zoomed terminal geometry is unavailable");

  await alice.page.getByRole("button", { name: "Pan tool" }).click();
  const scene = alice.page.locator(".terminal-scene");
  const sceneBox = await scene.boundingBox();
  if (!sceneBox) throw new Error("scene geometry is unavailable");
  await alice.page.mouse.move(sceneBox.x + sceneBox.width - 80, sceneBox.y + sceneBox.height - 90);
  await alice.page.mouse.down();
  await alice.page.mouse.move(sceneBox.x + sceneBox.width - 10, sceneBox.y + sceneBox.height - 50);
  await alice.page.mouse.up();
  const panned = await terminal.boundingBox();
  expect(panned?.x).toBeCloseTo(zoomed.x + 70, 0);
  expect(panned?.y).toBeCloseTo(zoomed.y + 40, 0);

  await alice.page.getByRole("button", { name: "Select tool" }).click();
  const titlebar = terminal.locator(".terminal-titlebar");
  const titlebarBox = await titlebar.boundingBox();
  if (!titlebarBox || !panned) throw new Error("panned title bar geometry is unavailable");
  await alice.page.mouse.move(titlebarBox.x + 80, titlebarBox.y + 18);
  await alice.page.mouse.down();
  await alice.page.mouse.move(titlebarBox.x + 155, titlebarBox.y + 48);
  await alice.page.mouse.up();
  const movedAtZoom = await terminal.boundingBox();
  expect(movedAtZoom?.x).toBeCloseTo(panned.x + 75, 0);
  expect(movedAtZoom?.y).toBeCloseTo(panned.y + 30, 0);

  await alice.page.getByRole("button", { name: "Reset zoom to 100%" }).click();
  await expect(alice.page.getByRole("status", { name: "Canvas zoom" })).toHaveText("100%");
});

test("moving control to an available terminal requires the explicit Switch action", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal("term-1");
  await alice.roomPage.openTerminal("term-2");
  await alice.roomPage.takeControl("term-1");

  await alice.roomPage.terminal("term-2").click();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect(
    alice.roomPage.terminal("term-2").getByRole("button", { name: "Switch control to term-2" }),
  ).toBeVisible();

  await alice.roomPage.switchControl("term-2");
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  await expect(alice.roomPage.terminalStatus("term-2")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect(bob.roomPage.terminalStatus("term-2")).toHaveAccessibleName(
    "Alice controls · View only",
  );
});

test("closing a terminal requires confirmation and is reflected for everyone", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();

  await alice.roomPage.requestClose("term-1");
  await expect(alice.roomPage.closeDialog()).toBeVisible();
  await alice.roomPage.cancelClose();
  await expect(alice.roomPage.terminal("term-1")).toBeVisible();

  await alice.roomPage.requestClose("term-1");
  await alice.roomPage.confirmClose();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(/Exited/);
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName(/Exited/);
});

test("exclusive and shared terminal modes are reflected for every participant", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  await expect(
    alice.roomPage.terminal("term-1").getByRole("img", { name: "Exclusive input mode" }),
  ).toBeVisible();

  await alice.roomPage.setTerminalMode("term-1", "Shared");
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Shared input");
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Shared input");
  await expect(
    bob.roomPage.terminal("term-1").getByRole("img", { name: "Shared input mode" }),
  ).toBeVisible();

  await alice.roomPage.setTerminalMode("term-1", "Exclusive");
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  await expect(
    bob.roomPage.terminal("term-1").getByRole("img", { name: "Exclusive input mode" }),
  ).toBeVisible();
});

test("the real agent kill switch makes terminals read-only and rejects remote input", async ({
  alice,
  bob,
  testSystem,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");

  testSystem.toggleKillSwitch();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "Read only · Remote input disabled",
  );
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "Read only · Remote input disabled",
  );

  const blockedMarker = `KILL_SWITCH_BLOCKED_${Date.now()}`;
  await alice.roomPage.typeInTerminal("term-1", `printf '${blockedMarker}\\n'`);
  testSystem.toggleKillSwitch();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  const synchronizationMarker = `AFTER_KILL_SWITCH_${Date.now()}`;
  await alice.roomPage.typeInTerminal("term-1", `printf '${synchronizationMarker}\\n'`);
  await expect.poll(() => bob.roomPage.terminalText("term-1")).toContain(synchronizationMarker);
  expect(await alice.roomPage.terminalText("term-1")).not.toContain(blockedMarker);
  expect(await bob.roomPage.terminalText("term-1")).not.toContain(blockedMarker);
});

test("Dock and Overview keep minimize and overview participant-local", async ({ alice, bob }) => {
  await alice.joinRoom();
  await bob.joinRoom();
  for (let terminalId = 1; terminalId <= 5; terminalId += 1) {
    await alice.roomPage.openTerminal(`term-${terminalId}`);
  }
  await expect(alice.roomPage.dockTerminals()).toHaveCount(5);
  await expect(bob.roomPage.dockTerminals()).toHaveCount(5);

  await alice.roomPage.minimize("term-1");
  await expect(alice.roomPage.terminal("term-1")).toBeHidden();
  await expect(alice.page.getByRole("button", { name: "Restore term-1" })).toBeVisible();
  await expect(bob.roomPage.terminal("term-1")).toBeVisible();
  await expect(bob.page.getByRole("button", { name: "Focus term-1" })).toBeVisible();

  const floatingGeometry = await alice.page.locator(".terminal-window").evaluateAll((windows) =>
    windows.map((window) => {
      const element = window as HTMLElement;
      return {
        left: element.style.left,
        top: element.style.top,
        width: element.style.width,
        height: element.style.height,
      };
    }),
  );
  await alice.roomPage.enterOverview();
  for (let terminalId = 1; terminalId <= 5; terminalId += 1) {
    await expect(alice.roomPage.terminal(`term-${terminalId}`)).toBeVisible();
  }
  const overviewBoxes = await alice.page.locator(".terminal-window").evaluateAll((windows) =>
    windows.map((window) => {
      const { left, top, right, bottom } = window.getBoundingClientRect();
      return { left, top, right, bottom };
    }),
  );
  const overlaps = overviewBoxes.flatMap((candidate, index) =>
    overviewBoxes
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
  await alice.roomPage.exitOverview();
  await expect
    .poll(() =>
      alice.page.locator(".terminal-window").evaluateAll((windows) =>
        windows.map((window) => {
          const element = window as HTMLElement;
          return {
            left: element.style.left,
            top: element.style.top,
            width: element.style.width,
            height: element.style.height,
          };
        }),
      ),
    )
    .toEqual(floatingGeometry);
  await expect(alice.roomPage.terminal("term-1")).toBeHidden();
});

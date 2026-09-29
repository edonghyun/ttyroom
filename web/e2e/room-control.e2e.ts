import { expect, test } from "./fixtures/actors.js";
import {
  givenAliceControlledTerminal,
  givenTwoParticipantsWithTerminal,
} from "./fixtures/workspace.js";

test("taking control grants Alice input while Bob receives the same real PTY output", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);
  const initialStatus = await alice.roomPage.waitForTerminalStatus("term-1", "Available");
  const exclusiveMode = await alice.roomPage
    .terminal("term-1")
    .getByRole("img", { name: "Exclusive input mode" })
    .isVisible();
  const marker = "CONTROLLED_PTY_OUTPUT";

  await alice.roomPage.takeControl("term-1");
  await alice.roomPage.printLine("term-1", marker);
  const aliceOutput = await alice.roomPage.outputContaining("term-1", marker);
  const bobOutput = await bob.roomPage.outputContaining("term-1", marker);

  expect(initialStatus).toBe("Available");
  expect(exclusiveMode).toBe(true);
  await expect(alice.roomPage.terminal("term-1")).toContainText("real-host");
  await expect(bob.roomPage.terminal("term-1")).toBeVisible();
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "Alice controls · View only",
  );
  expect(aliceOutput).toContain(marker);
  expect(bobOutput).toContain(marker);
});

test("control feedback appears above the canvas controls with an eight-pixel clearance", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);

  await alice.roomPage.takeControl("term-1");
  const toast = alice.page.getByText("Control acquired · term-1", { exact: true });
  await toast.waitFor({ state: "visible" });
  const toastBox = await toast.boundingBox();
  const canvasControlsBox = await alice.page
    .getByRole("navigation", { name: "Canvas controls" })
    .boundingBox();
  if (!toastBox || !canvasControlsBox) throw new Error("feedback geometry is unavailable");

  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(canvasControlsBox.y - 8);
});

test("selecting another participant's terminal neither acquires nor sends input", async ({
  alice,
  bob,
}) => {
  await givenAliceControlledTerminal(alice, bob);
  const rejectedMarker = "BOB_MUST_NOT_SEND";
  const synchronizationMarker = "ALICE_AFTER_BOB";

  // Even shell echo would violate rejection, so keep this marker contiguous.
  await bob.roomPage.typeInTerminal("term-1", `printf '${rejectedMarker}\\n'`);
  await alice.roomPage.printLine("term-1", synchronizationMarker);
  const aliceOutput = await alice.roomPage.outputContaining("term-1", synchronizationMarker);
  const bobOutput = await bob.roomPage.outputContaining("term-1", synchronizationMarker);

  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "Alice controls · View only",
  );
  expect(aliceOutput).not.toContain(rejectedMarker);
  expect(bobOutput).not.toContain(rejectedMarker);
});

test("moving control to an available terminal requires the explicit Switch action", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);
  await alice.roomPage.openTerminal("term-2");
  await alice.roomPage.takeControl("term-1");

  await alice.roomPage.terminal("term-2").click();
  const statusAfterSelection = await alice.roomPage.waitForTerminalStatus(
    "term-1",
    "You control · Esc to release",
  );
  const switchButton = alice.roomPage
    .terminal("term-2")
    .getByRole("button", { name: "Switch control to term-2" });
  await switchButton.waitFor({ state: "visible" });
  const switchOffered = await switchButton.isVisible();
  await alice.roomPage.switchControl("term-2");

  expect(statusAfterSelection).toBe("You control · Esc to release");
  expect(switchOffered).toBe(true);
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  await expect(alice.roomPage.terminalStatus("term-2")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect(bob.roomPage.terminalStatus("term-2")).toHaveAccessibleName(
    "Alice controls · View only",
  );
});

test("switching to shared input is reflected for both participants", async ({ alice, bob }) => {
  await givenTwoParticipantsWithTerminal(alice, bob);

  await alice.roomPage.setTerminalMode("term-1", "Shared");

  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Shared input");
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Shared input");
  await expect(
    bob.roomPage.terminal("term-1").getByRole("img", { name: "Shared input mode" }),
  ).toBeVisible();
});

test("switching shared input back to exclusive makes control available for both participants", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);
  await alice.roomPage.setTerminalMode("term-1", "Shared");
  await alice.roomPage.waitForTerminalStatus("term-1", "Shared input");
  await bob.roomPage.waitForTerminalStatus("term-1", "Shared input");

  await alice.roomPage.setTerminalMode("term-1", "Exclusive");

  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  await expect(bob.roomPage.terminalStatus("term-1")).toHaveAccessibleName("Available");
  await expect(
    bob.roomPage.terminal("term-1").getByRole("img", { name: "Exclusive input mode" }),
  ).toBeVisible();
});

test("the real connector kill switch makes terminals read-only and rejects remote input", async ({
  alice,
  bob,
  testSystem,
}) => {
  await givenAliceControlledTerminal(alice, bob);
  const blockedMarker = "KILL_SWITCH_BLOCKED";
  const synchronizationMarker = "AFTER_KILL_SWITCH";

  testSystem.toggleKillSwitch();
  const aliceDisabledStatus = await alice.roomPage.waitForTerminalStatus(
    "term-1",
    "Read only · Remote input disabled",
  );
  const bobDisabledStatus = await bob.roomPage.waitForTerminalStatus(
    "term-1",
    "Read only · Remote input disabled",
  );
  // Unlike a positive output marker, blocked input must not even be echoed.
  await alice.roomPage.typeInTerminal("term-1", `printf '${blockedMarker}\\n'`);
  testSystem.toggleKillSwitch();
  const restoredStatus = await alice.roomPage.waitForTerminalStatus(
    "term-1",
    "You control · Esc to release",
  );
  await alice.roomPage.printLine("term-1", synchronizationMarker);
  const aliceOutput = await alice.roomPage.outputContaining("term-1", synchronizationMarker);
  const bobOutput = await bob.roomPage.outputContaining("term-1", synchronizationMarker);

  expect(aliceDisabledStatus).toBe("Read only · Remote input disabled");
  expect(bobDisabledStatus).toBe("Read only · Remote input disabled");
  expect(restoredStatus).toBe("You control · Esc to release");
  expect(aliceOutput).not.toContain(blockedMarker);
  expect(bobOutput).not.toContain(blockedMarker);
});

import { expect, test } from "./fixtures/actors.js";

test("reload keeps participant identity, restores its lease, and restores shared geometry", async ({
  alice,
  bob,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");
  const clientId = await alice.clientId();

  await alice.roomPage.moveTerminal("term-1", { x: 130, y: 90 });
  const movedRect = await alice.roomPage.terminalRect("term-1");
  await expect.poll(() => bob.roomPage.terminalRect("term-1")).toEqual(movedRect);

  await alice.reloadRoom();

  expect(await alice.clientId()).toBe(clientId);
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect.poll(() => alice.roomPage.terminalRect("term-1")).toEqual(movedRect);
  await expect.poll(() => bob.roomPage.terminalRect("term-1")).toEqual(movedRect);
});

test("output produced during one disconnect is replayed exactly once", async ({ alice, bob }) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.setTerminalMode("term-1", "Shared");

  await alice.goOffline();
  await expect(alice.roomPage.connectionStatus("Reconnecting")).toBeVisible();
  const marker = `OFFLINE_REPLAY_${Date.now()}`;
  await bob.roomPage.typeInTerminal("term-1", `printf '${marker}\\n'`);
  await expect.poll(() => bob.roomPage.terminalText("term-1")).toContain(marker);

  await alice.goOnline();
  await expect(alice.roomPage.connectionStatus("Connected")).toBeVisible();
  await expect.poll(() => alice.roomPage.terminalText("term-1")).toContain(marker);
  expect((await alice.roomPage.terminalText("term-1")).split(marker)).toHaveLength(2);
});

test("an output gap enters restoring, replays scrollback, and clears after sync", async ({
  alice,
  bob,
  testSystem,
}) => {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.setTerminalMode("term-1", "Shared");
  await alice.roomPage.recordConnectionStates();

  const gapMarker = `GAP_REPLAY_${Date.now()}`;
  testSystem.setOutputDropThreshold(0);
  await bob.roomPage.typeInTerminal("term-1", `printf '${gapMarker}\\n'; cd /tmp`);
  await expect(bob.roomPage.terminal("term-1")).toContainText("/tmp", { timeout: 10_000 });

  const recoveryMarker = `GAP_RECOVERED_${Date.now()}`;
  testSystem.setOutputDropThreshold(4_194_304);
  await bob.roomPage.sendTerminalInputFrame("term-1", `printf '${recoveryMarker}\\n'`);
  await expect.poll(() => alice.roomPage.terminalText("term-1")).toContain(gapMarker);
  await expect.poll(() => alice.roomPage.terminalText("term-1")).toContain(recoveryMarker);
  await expect(alice.roomPage.connectionStatus("Connected")).toBeVisible();
  expect(await alice.roomPage.recordedConnectionStates()).toContain("Restoring");
});

test("reconnecting to a restarted server replaces the workspace with Room Gone", async ({
  alice,
  testSystem,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.moveTerminal("term-1", { x: 80, y: 60 });

  await testSystem.restartWithoutRooms();

  await expect(
    alice.page.getByRole("heading", { name: "This Quick Room no longer exists" }),
  ).toBeVisible();
  expect(await alice.roomPage.roomLayoutKeys()).toEqual([]);
});

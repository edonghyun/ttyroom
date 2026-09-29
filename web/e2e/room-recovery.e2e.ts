import { ConnectionFault } from "./fixtures/connection-fault.js";
import { expect, test } from "./fixtures/actors.js";
import type { BrowserParticipantActor } from "./fixtures/participant-actor.js";
import {
  givenTwoParticipantsWithTerminal,
  givenSharedInputWorkspace,
} from "./fixtures/workspace.js";
import { OutputGapFault } from "./fixtures/output-gap-fault.js";

test("reload keeps participant identity, restores its lease, and restores shared geometry", async ({
  alice,
  bob,
}) => {
  await givenTwoParticipantsWithTerminal(alice, bob);
  await alice.roomPage.takeControl("term-1");
  const clientId = await alice.clientId();
  const movedRect = await moveTerminalToBothParticipants(alice, bob);

  await alice.reloadRoom();

  expect(await alice.clientId()).toBe(clientId);
  await expect(alice.roomPage.terminalStatus("term-1")).toHaveAccessibleName(
    "You control · Esc to release",
  );
  await expect.poll(() => alice.roomPage.terminalRect("term-1")).toEqual(movedRect);
  await expect.poll(() => bob.roomPage.terminalRect("term-1")).toEqual(movedRect);
});

test("output produced during one disconnect is replayed exactly once", async ({ alice, bob }) => {
  const connection = await ConnectionFault.install(alice.page);
  await givenSharedInputWorkspace(alice, bob);
  const marker = "OFFLINE_REPLAY_OUTPUT";

  await connection.disconnect();
  const disconnectedState = await alice.roomPage.waitForConnection("Reconnecting");
  await bob.roomPage.printLine("term-1", marker);
  const liveOutput = await bob.roomPage.outputContaining("term-1", marker);
  connection.reconnect();
  const connectedState = await alice.roomPage.waitForConnection("Connected");
  const replayedOutput = await alice.roomPage.outputContaining("term-1", marker);

  expect(disconnectedState).toBe("Reconnecting");
  expect(liveOutput).toContain(marker);
  expect(connectedState).toBe("Connected");
  expectOutputOnce(replayedOutput, marker);
});

test("a reported output gap enters restoring and replays real server scrollback", async ({
  alice,
  bob,
}) => {
  const fault = await OutputGapFault.install(alice.page);
  await givenSharedInputWorkspace(alice, bob);
  const marker = "GAP_REPLAY_OUTPUT";

  fault.interruptNextOutput();
  await bob.roomPage.printLine("term-1", marker);
  const interruptedState = await alice.roomPage.waitForConnection("Restoring");
  fault.resume();
  const connectedState = await alice.roomPage.waitForConnection("Connected");
  const replayedOutput = await alice.roomPage.outputContaining("term-1", marker);

  expect(interruptedState).toBe("Restoring");
  expect(connectedState).toBe("Connected");
  expectOutputOnce(replayedOutput, marker);
});

test("reconnecting after room removal stops admission and clears the local layout", async ({
  alice,
  testSystem,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.moveTerminal("term-1", { x: 80, y: 60 });

  await testSystem.restartWithoutRooms();

  await expect(alice.page.getByRole("heading", { name: "Access unavailable" })).toBeVisible();
  expect(await alice.roomPage.roomLayoutKeys()).toEqual([]);
});

test("a persistent server restart restores shared geometry and the same live PTY", async ({
  alice,
  testSystem,
}) => {
  await alice.joinRoom();
  await alice.roomPage.openTerminal();
  await alice.roomPage.takeControl("term-1");
  await alice.roomPage.moveTerminal("term-1", { x: 80, y: 60 });
  const before = await alice.roomPage.terminalRect("term-1");
  await alice.roomPage.typeInTerminal(
    "term-1",
    "export TTYROOM_BROWSER_SENTINEL=browser-'survived'; printf '%s%s\\n' 'restart-' 'armed'",
  );
  await alice.roomPage.outputContaining("term-1", "restart-armed");

  await testSystem.restart();
  const restoredStatus = await alice.roomPage.waitForTerminalStatus("term-1", "Available");
  await alice.roomPage.takeControl("term-1");
  await alice.roomPage.typeInTerminal("term-1", "printf '%s\\n' \"$TTYROOM_BROWSER_SENTINEL\"");

  expect(restoredStatus).toBe("Available");
  await expect.poll(() => alice.roomPage.terminalText("term-1")).toContain("browser-survived");
  await expect.poll(() => alice.roomPage.terminalRect("term-1")).toEqual(before);
  await expect(alice.roomPage.connectionStatus("Connected")).toBeVisible();
});

/** Setup completes when the peer has received the move, before testing reload recovery. */
async function moveTerminalToBothParticipants(
  alice: BrowserParticipantActor,
  bob: BrowserParticipantActor,
) {
  await alice.roomPage.moveTerminal("term-1", { x: 130, y: 90 });
  const movedRect = await alice.roomPage.terminalRect("term-1");
  await expect.poll(() => bob.roomPage.terminalRect("term-1")).toEqual(movedRect);
  return movedRect;
}

function expectOutputOnce(output: string, marker: string) {
  expect(
    output.split(marker).length - 1,
    `Expected one ${marker} in terminal output:\n${output}`,
  ).toBe(1);
}

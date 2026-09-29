import type { BrowserParticipantActor } from "./participant-actor.js";

/** Actor fixtures own resources; this preparation does not acquire control or change input mode. */
export async function givenTwoParticipantsWithTerminal(
  alice: BrowserParticipantActor,
  bob: BrowserParticipantActor,
) {
  await alice.joinRoom();
  await bob.joinRoom();
  await alice.roomPage.openTerminal();
}

/** Completes after both participants have observed Alice's lease. */
export async function givenAliceControlledTerminal(
  alice: BrowserParticipantActor,
  bob: BrowserParticipantActor,
) {
  await givenTwoParticipantsWithTerminal(alice, bob);
  await alice.roomPage.takeControl("term-1");
  await alice.roomPage.waitForTerminalStatus("term-1", "You control · Esc to release");
  await bob.roomPage.waitForTerminalStatus("term-1", "Alice controls · View only");
}

/** Shared input is ready on both clients before a test interrupts either connection. */
export async function givenSharedInputWorkspace(
  alice: BrowserParticipantActor,
  bob: BrowserParticipantActor,
) {
  await givenTwoParticipantsWithTerminal(alice, bob);
  await alice.roomPage.setTerminalMode("term-1", "Shared");
  await alice.roomPage.waitForTerminalStatus("term-1", "Shared input");
  await bob.roomPage.waitForTerminalStatus("term-1", "Shared input");
}

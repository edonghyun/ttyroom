import type { ParticipantClient } from "./harness.js";
import { waitUntil } from "@ttyroom/test-support/wait-until";
import { printMarker } from "./shell-commands.js";

/** Executes shell output whose marker cannot be mistaken for input echo. Does not await output. */
export function printOutput(
  participant: ParticipantClient,
  terminalId: number,
  marker: string,
): void {
  participant.sendInput(terminalId, printMarker(marker));
}

/** Finish shell preparation before the scenario starts; timeout reports a setup failure. */
export async function runUntilOutput(
  participant: ParticipantClient,
  terminalId: number,
  command: string,
  readyMarker: string,
): Promise<void> {
  participant.sendInput(terminalId, command);
  await waitUntil(() => participant.outputText(terminalId).includes(readyMarker), {
    failure: () =>
      `Shell preparation timed out: ${readyMarker}\n${participant.outputText(terminalId)}`,
  });
}

/** Participant welcome can precede Connector recovery; input must wait for the host. */
export async function reconnectToHost(
  participant: ParticipantClient,
  hostId: string,
): Promise<void> {
  await participant.reconnect();
  await waitUntil(() => participant.host(hostId)?.online === true, {
    failure: () => `Host ${hostId} did not reconnect`,
  });
}

/** Wait for command execution, then capture a completed replay for negative output assertions. */
export async function captureOutputReplay(
  participant: ParticipantClient,
  terminalId: number,
  afterOutput: string,
): Promise<string> {
  await waitUntil(() => participant.outputText(terminalId).includes(afterOutput), {
    failure: () =>
      `Output missing before replay: ${afterOutput}\n${participant.outputText(terminalId)}`,
  });
  await participant.resyncOutput(terminalId);
  return participant.outputText(terminalId);
}

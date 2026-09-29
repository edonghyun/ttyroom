import { expect } from "vitest";
import type { LeaseResult, RoomSnapshot } from "@ttyroom/protocol";
import type { ParticipantClient } from "./harness.js";

export function assertControlGranted(result: LeaseResult): void {
  expect(result).toMatchObject({ kind: "granted" });
}

export function assertControlDenied(result: LeaseResult, holder: ParticipantClient): void {
  expect(result).toEqual({ kind: "denied", holderClientId: holder.clientId });
}

export async function assertOutputContains(
  participant: ParticipantClient,
  terminalId: number,
  text: string,
): Promise<void> {
  await expect
    .poll(() => participant.outputText(terminalId), {
      message: `Output observed by ${participant.clientId}`,
    })
    .toContain(text);
}

export async function assertTerminalState(
  participant: ParticipantClient,
  terminalId: number,
  expected: Partial<RoomSnapshot["terminals"][number]>,
): Promise<void> {
  await expect.poll(() => participant.terminal(terminalId)).toMatchObject(expected);
}

export async function assertControlHolder(
  observer: ParticipantClient,
  terminalId: number,
  holder: ParticipantClient,
): Promise<void> {
  await expect.poll(() => observer.leaseHolder(terminalId)).toBe(holder.clientId);
}

export async function assertReplayCompleted(
  participant: ParticipantClient,
  terminalId: number,
): Promise<void> {
  await expect.poll(() => participant.syncedSeq(terminalId)).toBeGreaterThan(0);
}

/** Wait for replay completion and inspect raw received frames without normalizing them. */
export async function assertReplayExactlyOnce(
  participant: ParticipantClient,
  terminalId: number,
  marker: string,
): Promise<void> {
  await assertReplayCompleted(participant, terminalId);
  expect(participant.outputText(terminalId).split(marker).length - 1).toBe(1);
  const sequences = participant.outputSequences(terminalId);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
}

/** Inspect completed replay evidence; never sends commands or changes participant state. */
export function assertRoomOutputIsolated(
  output: string,
  expected: { ownOutput: string; foreignOutput: string },
): void {
  expect(output).toContain(expected.ownOutput);
  expect(output).not.toContain(expected.foreignOutput);
}

export async function assertHostDisconnected(
  participant: ParticipantClient,
  hostId: string,
): Promise<void> {
  await expect
    .poll(() => participant.lastMessages())
    .toContainEqual({
      type: "room-event",
      event: { kind: "host-offline", hostId },
    });
}

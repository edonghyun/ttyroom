import { runUntilOutput } from "./actions.js";
import { printMarker } from "./shell-commands.js";
import { given, type ParticipantClient } from "./harness.js";
import type { TestPolicy } from "@ttyroom/test-support/server-process";

interface RoomOptions {
  name?: string;
  policy?: Partial<TestPolicy>;
}

/** Owns all processes and connections, including cleanup when preparation fails. */
export async function roomFixture(options: RoomOptions = {}) {
  const server = await given.server(options.policy);
  try {
    const room = await server.room(options.name);
    return {
      server,
      room,
      async [Symbol.asyncDispose]() {
        await server.close();
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** Connected participants and one computer; no terminal has been opened yet. */
export async function connectedRoomFixture<const Name extends string>(
  names: readonly [Name, ...Name[]],
  options: RoomOptions = {},
) {
  if (new Set(names).size !== names.length) throw new Error("Participant names must be unique");
  const fixture = await roomFixture(options);
  try {
    const connector = await given.connector(fixture.room, "host-a");
    const participants = Object.create(null) as Record<Name, ParticipantClient>;
    for (const name of names) {
      participants[name] = await given.participant(fixture.room, name);
    }
    return { ...fixture, connector, participants };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

/** Opens one terminal as the first participant; nobody holds input control yet. */
export async function terminalFixture<const Name extends string>(
  names: readonly [Name, ...Name[]],
  options: RoomOptions = {},
) {
  const fixture = await connectedRoomFixture(names, options);
  try {
    const terminalId = await fixture.participants[names[0]].openTerminal(fixture.connector.hostId);
    return { ...fixture, terminalId };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

async function prepareControl(participant: ParticipantClient, terminalId: number): Promise<void> {
  const result = await participant.requestControl(terminalId);
  if (result.kind !== "granted")
    throw new Error(`Fixture input control denied: ${participant.clientId}`);
}

/** First participant holds input control; acquisition is a precondition of the scenario. */
export async function controlledTerminalFixture<const Name extends string>(
  names: readonly [Name, ...Name[]],
  options: RoomOptions = {},
) {
  const fixture = await terminalFixture(names, options);
  try {
    await prepareControl(fixture.participants[names[0]], fixture.terminalId);
    return fixture;
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

/** Same server, separate rooms, matching room-local terminal IDs, both ready for input. */
export async function isolatedRoomsFixture() {
  const fixture = await roomFixture({ name: "A" });
  try {
    const roomB = await fixture.server.room("B");
    const hostA = await given.connector(fixture.room);
    const hostB = await given.connector(roomB);
    const alice = await given.participant(fixture.room, "alice");
    const bob = await given.participant(roomB, "bob");
    const terminalA = await alice.openTerminal(hostA.hostId);
    const terminalB = await bob.openTerminal(hostB.hostId);
    if (terminalA !== terminalB)
      throw new Error("Room isolation fixture requires matching terminal IDs");
    await prepareControl(alice, terminalA);
    await prepareControl(bob, terminalB);
    return { ...fixture, alice, bob, terminalId: terminalA };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

/** Existing output is a precondition for late-join and replay scenarios. */
export async function outputHistoryFixture(marker: string, options: RoomOptions = {}) {
  const fixture = await controlledTerminalFixture(["alice"], options);
  try {
    await runUntilOutput(
      fixture.participants.alice,
      fixture.terminalId,
      printMarker(marker),
      marker,
    );
    return fixture;
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

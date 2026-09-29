import { encodeDataFrame } from "@ttyroom/protocol";
import { protocolWorkspaceFixture } from "./protocol-fixture.js";
import type { TestPolicy } from "./server-process.js";
import { type ProbePacket, SocketProbe } from "./socket-probe.js";

/** One recovered terminal; owns output sequencing and the replay completion boundary. */
export async function outputPolicyScenario(policy: Partial<TestPolicy>) {
  const fixture = await protocolWorkspaceFixture([7], policy);
  let lastOutputSeq = 0;

  function sendOutput(text: string) {
    fixture.host.sendBytes(
      encodeDataFrame({
        kind: "output",
        terminalId: 7,
        seq: ++lastOutputSeq,
        payload: Buffer.from(text),
      }),
    );
  }

  return {
    sendOutput,
    async publishOutput(...texts: string[]) {
      for (const text of texts) sendOutput(text);
      fixture.host.send({ type: "terminal-replay-complete", terminalId: 7, lastOutputSeq });
      return captureOutputThroughSync(fixture.observer);
    },
    async replayFor(clientId: string) {
      const participant = await fixture.join(clientId, "participant");
      return captureOutputThroughSync(participant.peer);
    },
    async hostDisconnection() {
      await fixture.host.closed();
      return fixture.observer.next();
    },
    [Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
  };
}

/** Records the complete arrival order as well as the text projection used by policy assertions. */
async function captureOutputThroughSync(peer: SocketProbe) {
  const packets: ProbePacket[] = [];
  for (;;) {
    const packet = await peer.nextPacket();
    packets.push(packet);
    if (packet.kind === "control" && packet.message.type === "sync") {
      return {
        packets,
        texts: packets.flatMap((received) =>
          received.kind === "binary" ? [Buffer.from(received.frame.payload).toString()] : [],
        ),
        sync: packet.message,
      };
    }
  }
}

/** A joined participant whose setup announcement has already reached the observer. */
export async function participantPolicyScenario(policy: Partial<TestPolicy>) {
  const fixture = await protocolWorkspaceFixture([], policy);
  try {
    const bob = await fixture.join("bob", "participant");
    const announcement = await fixture.observer.next();
    if (
      announcement.type !== "room-event" ||
      announcement.event.kind !== "participant-joined" ||
      announcement.event.participant.clientId !== "bob"
    ) {
      throw new Error(`Expected Bob's join announcement, received ${JSON.stringify(announcement)}`);
    }
    return {
      async disconnectParticipant() {
        await bob.peer.disconnect();
        return fixture.observer.next();
      },
      [Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
    };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

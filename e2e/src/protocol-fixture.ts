import type { ServerMessage } from "@ttyroom/protocol";
import { roomFixture } from "./fixtures.js";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";
import type { TestRoom } from "./harness.js";
import type { TestPolicy } from "@ttyroom/test-support/server-process";

export async function protocolRoomFixture(policy: Partial<TestPolicy> = {}) {
  const fixture = await roomFixture({ policy });
  const peers: SocketProbe[] = [];
  async function join(
    clientId: string,
    role: "participant" | "host",
    room: TestRoom = fixture.room,
  ) {
    const peer = await SocketProbe.connect(room.baseUrl);
    peers.push(peer);
    peer.send({
      type: "hello",
      protocolVersion: 7,
      roomId: room.roomId,
      token: room.token,
      clientId,
      name: clientId,
      role,
    });
    const welcome = await peer.next();
    if (welcome.type !== "welcome") throw new Error(`Expected welcome, received ${welcome.type}`);
    return { peer, welcome };
  }
  async function dispose() {
    try {
      await Promise.all(peers.map((peer) => peer[Symbol.asyncDispose]()));
    } finally {
      await fixture[Symbol.asyncDispose]();
    }
  }
  try {
    const observer = (await join("alice", "participant")).peer;
    const host = (await join("host", "host")).peer;
    return {
      ...fixture,
      join,
      observer,
      host,
      // Test-only cycle: changes input permission; use before introducing leases.
      // Same-host ordering guarantees a final true transition even if input was already allowed.
      async captureThroughInputCycle() {
        host.send({ type: "host-input-state", remoteInputAllowed: false });
        host.send({ type: "host-input-state", remoteInputAllowed: true });
        const messages: ServerMessage[] = [];
        for (;;) {
          const message = await observer.next();
          messages.push(message);
          if (
            message.type === "room-event" &&
            message.event.kind === "host-input-state-changed" &&
            message.event.hostId === "host" &&
            message.event.remoteInputAllowed
          )
            return messages;
        }
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Fresh host with known runtimes, ready for terminal actions; owns failed setup cleanup too. */
export async function protocolWorkspaceFixture(
  terminalIds: number[] = [],
  policy: Partial<TestPolicy> = {},
) {
  const fixture = await protocolRoomFixture(policy);
  try {
    fixture.host.send({
      type: "host-inventory",
      terminals: terminalIds.map((terminalId) => ({
        terminalId,
        runtimeId: `runtime-${terminalId}`,
        firstRetainedSeq: 0,
        lastOutputSeq: 0,
      })),
    });
    const ready = await fixture.host.next();
    if (ready.type !== "host-ready") throw new Error(`Expected host-ready, received ${ready.type}`);
    const connected = await fixture.observer.next();
    if (
      connected.type !== "room-event" ||
      connected.event.kind !== "host-connected" ||
      connected.event.host.hostId !== "host"
    )
      throw new Error("Expected initial host-connected");
    for (const terminalId of terminalIds) {
      const opened = await fixture.observer.next();
      if (
        opened.type !== "room-event" ||
        opened.event.kind !== "terminal-opened" ||
        opened.event.terminal.terminalId !== terminalId
      )
        throw new Error(`Expected recovered terminal ${terminalId}`);
    }
    return fixture;
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

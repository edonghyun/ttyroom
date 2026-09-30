import { describe, expect, it } from "vitest";
import { ServerProcess, type TestCapacity } from "./server-process.js";
import { SocketProbe } from "./socket-probe.js";
import { registeredRoom } from "./registered-room.js";

describe("Spring membership 수명과 한도", () => {
  it.each([
    { membershipsPerRoom: 2, memberships: 4 },
    { membershipsPerRoom: 4, memberships: 3 },
  ])("v7의 유예 중 identity도 예산을 쓰며 다른 방은 응답한다: %j", async (capacity) => {
    await using world = await legacyRooms(capacity);
    const first = await world.room();
    const second = await world.room();
    const keeper = await first.join("keeper");
    const departing = await first.join("departing");
    await keeper.peer.next(); // Fixture join notification precedes the tested departure.
    const independent = await second.join("independent");

    await departing.peer.disconnect();
    const rejected = await first.join("excess");
    independent.peer.send({ type: "acquire-lease", terminalId: 42 });
    const responsive = await independent.peer.next();
    const expired = await keeper.peer.next();
    const accepted = await first.join("replacement");

    expect(rejected.message).toMatchObject({ type: "error", code: "capacity-exhausted" });
    expect(responsive).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    expect(expired).toMatchObject({
      type: "room-event",
      event: { kind: "participant-left", clientId: "departing" },
    });
    expect(accepted.message).toMatchObject({
      type: "welcome",
      snapshot: { participants: [expect.anything(), expect.anything()] },
    });
  });

  it("v8도 membership을 따로 제한하며 같은 주체의 교체와 취소 후 입장을 허용한다", async () => {
    await using room = await registeredRoom(8, { capacity: { memberships: 1 } });
    const alice = await room.participant();
    const bob = await room.participant();
    const original = await room.connect(alice.secret, "Alice");

    const excess = await room.connect(bob.secret, "Bob");
    const replacement = await room.connect(alice.secret, "Alice again");
    await original.peer.closed();
    const revoked = await room.revoke("participants", alice.id);
    const accepted = await room.connect(bob.secret, "Bob");

    expect(excess.message).toMatchObject({ type: "error", code: "capacity-exhausted" });
    expect(replacement.message).toMatchObject({ type: "welcome", selfClientId: alice.id });
    expect(revoked.status).toBe(204);
    expect(accepted.message).toMatchObject({ type: "welcome", selfClientId: bob.id });
  });
});

async function legacyRooms(capacity: Partial<TestCapacity>) {
  const server = await ServerProcess.start(
    { participantGraceMs: 2_000 },
    { protocolVersion: 7, capacity, startupTimeoutMs: 30_000 },
  );
  const peers: SocketProbe[] = [];
  return {
    async room() {
      const response = await fetch(`${server.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status !== 201) throw new Error(`Room setup failed: ${response.status}`);
      const invitation = (await response.json()) as { roomId: string; token: string };
      return {
        async join(clientId: string) {
          const peer = await SocketProbe.connect(server.baseUrl);
          peers.push(peer);
          peer.send({
            type: "hello",
            protocolVersion: 7,
            ...invitation,
            clientId,
            name: clientId,
            role: "participant",
          });
          return { peer, message: await peer.next() };
        },
      };
    },
    async [Symbol.asyncDispose]() {
      try {
        await Promise.all(peers.map((peer) => peer[Symbol.asyncDispose]()));
      } finally {
        await server.close();
      }
    },
  };
}

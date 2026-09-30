import { describe, expect, it } from "vitest";
import { ServerProcess, type TestCapacity } from "./server-process.js";
import { SocketProbe } from "./socket-probe.js";
import { registeredRoom } from "./registered-room.js";

describe("Spring 영속 host 보관 한도", () => {
  it.each([
    {
      capacity: { storedHostsPerRoom: 2, storedHosts: 4 },
      error: "room stored hosts capacity exhausted",
    },
    {
      capacity: { storedHostsPerRoom: 4, storedHosts: 3 },
      error: "stored hosts capacity exhausted",
    },
  ])(
    "재시작 후 새 host만 거절하고 기존 소유권과 다른 방의 응답을 유지한다: $error",
    async ({ capacity, error }) => {
      await using world = await legacyWorld(capacity);
      const first = await world.room();
      const second = await world.room();
      const owner = await first.host("owner");
      await reportTerminal(owner.peer);
      await first.host("offline");
      await second.host("other");

      await world.server.restart();
      const rejections = [];
      for (let i = 0; i < 20; i++) rejections.push((await first.host(`excess-${i}`)).message);
      const recovered = await first.host("owner");
      const ready = await reportTerminal(recovered.peer);
      const healthy = await second.participant("alice");
      healthy.peer.send({ type: "acquire-lease", terminalId: 42 });
      const responsive = await healthy.peer.next();

      expect(rejections).toEqual(
        Array.from({ length: 20 }, () => ({
          type: "error",
          code: "capacity-exhausted",
          message: error,
        })),
      );
      expect(recovered.message).toMatchObject({
        type: "welcome",
        snapshot: {
          hosts: [
            expect.objectContaining({ hostId: "owner" }),
            expect.objectContaining({ hostId: "offline" }),
          ],
          terminals: [expect.objectContaining({ terminalId: 7, hostId: "owner" })],
        },
      });
      expect(ready).toMatchObject({ type: "host-ready" });
      expect(responsive).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    },
  );

  it("유예 만료가 저장된 host를 제거하면 슬롯을 다시 사용한다", async () => {
    await using world = await legacyWorld({ storedHosts: 1 });
    const room = await world.room();
    const keeper = await room.participant("keeper");
    const original = await room.host("original");

    const excess = await room.host("too-early");
    await original.peer.disconnect();
    const offline = await keeper.peer.next();
    const removed = await keeper.peer.next();
    const accepted = await room.host("replacement");
    const fullAgain = await room.host("excess");

    expect(excess.message).toMatchObject({ type: "error", code: "capacity-exhausted" });
    expect(offline).toMatchObject({
      type: "room-event",
      event: { kind: "host-offline", hostId: "original" },
    });
    expect(removed).toMatchObject({
      type: "room-event",
      event: { kind: "host-removed", hostId: "original" },
    });
    expect(accepted.message).toMatchObject({
      type: "welcome",
      snapshot: { hosts: [expect.objectContaining({ hostId: "replacement" })] },
    });
    expect(fullAgain.message).toMatchObject({ type: "error", code: "capacity-exhausted" });
  });

  it("v8의 credential 발급과 host 보관은 별도이며 취소 후 입장을 허용한다", async () => {
    await using room = await registeredRoom(8, { capacity: { storedHosts: 1 } });
    const first = await room.host();
    const second = await room.host();
    await room.connect(first.secret, "First host");

    const rejected = await room.connect(second.secret, "Second host");
    const revoked = await room.revoke("hosts", first.id);
    const accepted = await room.connect(second.secret, "Second host");

    expect(rejected.message).toMatchObject({ type: "error", code: "capacity-exhausted" });
    expect(revoked.status).toBe(204);
    expect(accepted.message).toMatchObject({ type: "welcome", selfClientId: second.id });
  });
});

async function reportTerminal(peer: SocketProbe) {
  peer.send({
    type: "host-inventory",
    terminals: [{ terminalId: 7, runtimeId: "runtime", firstRetainedSeq: 0, lastOutputSeq: 0 }],
  });
  const ready = await peer.next();
  if (ready.type !== "host-ready") throw new Error("Host inventory setup did not complete");
  return ready;
}

async function legacyWorld(capacity: Partial<TestCapacity>) {
  const server = await ServerProcess.start(
    { hostGraceMs: 2_000 },
    { protocolVersion: 7, capacity, startupTimeoutMs: 30_000 },
  );
  const peers: SocketProbe[] = [];
  return {
    server,
    async room() {
      const response = await fetch(`${server.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status !== 201) throw new Error(`Room setup failed: ${response.status}`);
      const invitation = (await response.json()) as { roomId: string; token: string };
      async function join(clientId: string, role: "host" | "participant") {
        const peer = await SocketProbe.connect(server.baseUrl);
        peers.push(peer);
        peer.send({
          type: "hello",
          protocolVersion: 7,
          ...invitation,
          clientId,
          name: clientId,
          role,
        });
        const message = await peer.next();
        if (message.type === "error") await peer.closed();
        return { peer, message };
      }
      return {
        host: (id: string) => join(id, "host"),
        participant: (id: string) => join(id, "participant"),
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

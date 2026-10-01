import { describe, expect, it } from "vitest";
import { encodeDataFrame } from "@ttyroom/protocol";
import { registeredRoom } from "@ttyroom/test-support/registered-room";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";

describe("Spring workspace 복구", () => {
  it.each([4, 16])(
    "1 MiB history가 찬 terminal %i개의 입장과 재접속을 완료한다",
    async (terminals) => {
      await using room = await registeredRoom();
      await fillWorkspaceHistory(room, terminals);
      const credential = await room.participant();

      const first = await room.connect(credential.secret, "Alice");
      const initial = await restoredHistory(first.peer, terminals);
      await first.peer.disconnect();
      const rejoined = await room.connect(credential.secret, "Alice");
      const restored = await restoredHistory(rejoined.peer, terminals);
      rejoined.peer.send({ type: "acquire-lease", terminalId: 999 });
      const responsive = await rejoined.peer.next();

      expect(first.message).toMatchObject({ type: "welcome", selfClientId: credential.id });
      expect(rejoined.message).toMatchObject({ type: "welcome", selfClientId: credential.id });
      expect(initial).toEqual(expectedHistory(terminals));
      expect(restored).toEqual(initial);
      expect(responsive).toMatchObject({ type: "lease-invalid", terminalId: 999 });
    },
  );
});

async function fillWorkspaceHistory(
  room: Awaited<ReturnType<typeof registeredRoom>>,
  count: number,
) {
  const credential = await room.host();
  const { peer } = await room.connect(credential.secret, "Synthetic host");
  const inventory = {
    type: "host-inventory",
    terminals: Array.from({ length: count }, (_, index) => ({
      terminalId: index + 1,
      runtimeId: `runtime-${index + 1}`,
      firstRetainedSeq: 0,
      lastOutputSeq: 0,
    })),
  };
  peer.send(inventory);
  if ((await peer.next()).type !== "host-ready") throw new Error("Host inventory not ready");
  for (let terminalId = 1; terminalId <= count; terminalId++) {
    const payload = Buffer.alloc(4096, terminalId);
    for (let seq = 1; seq <= 256; seq++)
      peer.sendBytes(encodeDataFrame({ kind: "output", terminalId, seq, payload }));
  }
  // A later control on the same host connection observes the preceding binary output.
  peer.send(inventory);
  if ((await peer.next()).type !== "host-ready")
    throw new Error("History preparation not complete");
}

async function restoredHistory(peer: SocketProbe, count: number) {
  const packets: unknown[] = [];
  let syncs = 0;
  while (syncs < count) {
    const packet = await peer.nextPacket();
    if (packet.kind === "binary") {
      const { terminalId, seq, payload } = packet.frame;
      packets.push({
        terminalId,
        seq,
        bytes: payload.length,
        contentMatches: payload.every((byte) => byte === terminalId),
      });
    } else {
      packets.push(packet.message);
      if (packet.message.type === "sync") syncs++;
    }
  }
  return packets;
}

function expectedHistory(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const terminalId = index + 1;
    return [
      ...Array.from({ length: 256 }, (_, i) => ({
        terminalId,
        seq: i + 1,
        bytes: 4096,
        contentMatches: true,
      })),
      { type: "sync", terminalId, seq: 256 },
    ];
  }).flat();
}

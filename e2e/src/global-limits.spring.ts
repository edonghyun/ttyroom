import { describe, expect, it } from "vitest";
import { registeredRoom } from "./registered-room.js";
import { SocketProbe } from "./socket-probe.js";

describe("Spring 전역 자원 한도", () => {
  it("재시작으로 복원된 방도 한도에 포함하고 기존 방의 입장은 유지한다", async () => {
    await using room = await registeredRoom(8, { capacity: { rooms: 1 } });
    const alice = await room.participant();

    await room.server.restart();
    const rejected = await fetch(`${room.server.baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    const error = await rejected.json();
    const joined = await room.connect(alice.secret, "Alice");

    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(error).toEqual({ error: "rooms capacity exhausted" });
    expect(joined.message).toMatchObject({ type: "welcome", selfClientId: alice.id });
  });

  it.each([
    { terminals: 1, retainedHistoryBytes: 2_097_152 },
    { terminals: 2, retainedHistoryBytes: 1_048_576 },
  ])("terminal 또는 history 예산을 넘는 inventory 전체를 거절한다: %j", async (capacity) => {
    await using room = await registeredRoom(8, { capacity });
    const host = await room.host();
    const { peer } = await room.connect(host.secret, "Host");

    peer.send(inventory(2));
    const rejected = await peer.next();
    peer.send(inventory(1));
    const ready = await peer.next();
    const alice = await room.participant();
    const joined = await room.connect(alice.secret, "Alice");

    expect(rejected).toMatchObject({ type: "error", code: "capacity-exhausted" });
    expect(ready).toMatchObject({ type: "host-ready" });
    expect(joined.message).toMatchObject({
      type: "welcome",
      snapshot: { terminals: [expect.objectContaining({ terminalId: 1 })] },
    });
  });

  it("인증 전 연결의 초과 입장을 거절해도 기존 참가자는 요청을 처리한다", async () => {
    await using room = await registeredRoom(8, { capacity: { connections: 2 } });
    const alice = await room.participant();
    const { peer } = await room.connect(alice.secret, "Alice");
    await using idle = await SocketProbe.connect(room.server.baseUrl);

    await using excess = await SocketProbe.connect(room.server.baseUrl);
    const closure = await excess.closureCode();
    peer.send({ type: "acquire-lease", terminalId: 42 });
    const responsive = await peer.next();
    await idle.disconnect();
    const bob = await room.participant();
    const replacement = await room.connect(bob.secret, "Bob");

    expect(closure).toBe(1013);
    expect(responsive).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    expect(replacement.message).toMatchObject({ type: "welcome", selfClientId: bob.id });
  });

  it("hello 없이 점유한 슬롯은 시간 제한 후 반환한다", async () => {
    await using room = await registeredRoom(8, { capacity: { connections: 1 } });
    await using idle = await SocketProbe.connect(room.server.baseUrl);

    const closure = await idle.closureCode();
    const alice = await room.participant();
    const joined = await room.connect(alice.secret, "Alice");

    expect(closure).toBe(1008);
    expect(joined.message).toMatchObject({ type: "welcome", selfClientId: alice.id });
  });
});

function inventory(count: number) {
  return {
    type: "host-inventory",
    terminals: Array.from({ length: count }, (_, index) => ({
      terminalId: index + 1,
      runtimeId: `runtime-${index + 1}`,
      firstRetainedSeq: 0,
      lastOutputSeq: 0,
    })),
  };
}

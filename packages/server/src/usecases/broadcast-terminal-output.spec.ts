import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../ports/policy.js";
import { expectMessageToMatch } from "../test/matchers.js";
import {
  RoomTestContext,
  type HostHandle,
  type ParticipantHandle,
  type TestRoom,
} from "../test/room-test-context.js";

describe("broadcastTerminalOutput — 역할: 출력 팬아웃과 느린 참여자 격리", () => {
  it("host 출력이 참여자 전원에게 서버가 부여한 seq로 전달된다", async () => {
    const { alice, bob, host, terminalId } = await setupOpenTerminal();

    host.sendOutput(terminalId, 41, "first");
    host.sendOutput(terminalId, 42, "second");

    expect(alice.conn.dataFrames).toMatchObject([
      { kind: "output", terminalId, seq: 1 },
      { kind: "output", terminalId, seq: 2 },
    ]);
    expect(bob.conn.dataFrames).toMatchObject([
      { kind: "output", terminalId, seq: 1 },
      { kind: "output", terminalId, seq: 2 },
    ]);
  });

  it("송신 버퍼가 임계 이상인 참여자에게만 출력을 드롭한다", async () => {
    const { alice, bob, host, terminalId } = await setupOpenTerminal();
    bob.conn.bufferedBytesValue = DEFAULT_POLICY.sendBufferDropThresholdBytes;

    host.sendOutput(terminalId, 1, "hi");

    expect(alice.conn.dataFrames).toHaveLength(1);
    expect(bob.conn.dataFrames).toHaveLength(0);
  });

  it("드롭된 참여자의 버퍼가 회복되면 sync와 output-gap 뒤 스트림을 재개한다", async () => {
    const { bob, host, terminalId } = await setupOpenTerminal();
    bob.conn.clear();
    bob.conn.bufferedBytesValue = DEFAULT_POLICY.sendBufferDropThresholdBytes;
    host.sendOutput(terminalId, 1, "a");
    host.sendOutput(terminalId, 2, "b");

    bob.conn.bufferedBytesValue = 0;
    host.sendOutput(terminalId, 3, "c");

    expectMessageToMatch(bob.conn.messages, "sync", { terminalId, seq: 2 });
    expectMessageToMatch(bob.conn.messages, "output-gap", {
      terminalId,
      fromSeq: 1,
      toSeq: 2,
    });
    expect(bob.conn.messages.map((message) => message.type)).toEqual(["sync", "output-gap"]);
    expect(bob.conn.dataFrames).toMatchObject([{ kind: "output", terminalId, seq: 3 }]);
  });

  it("스크롤백에서 프레임이 퇴출돼도 서버 seq는 단조 증가한다", async () => {
    const ctx = new RoomTestContext({ policy: { scrollbackBytesPerTerminal: 1 } });
    const { alice, host, terminalId } = await setupOpenTerminal(ctx);

    host.sendOutput(terminalId, 100, "oversized");
    host.sendOutput(terminalId, 101, "x");

    expect(alice.conn.dataFrames).toMatchObject([{ seq: 1 }, { seq: 2 }]);
  });

  it("다른 host는 소유하지 않은 터미널의 출력을 주입할 수 없다", async () => {
    const { alice, ctx, room, terminalId } = await setupOpenTerminal();
    const attacker = await ctx.connectHost(room, "attacker");

    attacker.sendOutput(terminalId, 1, "spoofed");

    expect(alice.conn.dataFrames).toEqual([]);
    expectMessageToMatch(attacker.conn.messages, "error", { code: "bad-message" });
  });

  it("같은 terminalId를 쓰는 다른 Room의 seq와 스크롤백을 공유하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const first = await setupOpenTerminal(ctx);
    first.host.sendOutput(first.terminalId, 1, "room-one");
    const second = await setupOpenTerminal(ctx);

    second.host.sendOutput(second.terminalId, 1, "room-two");
    const late = await ctx.connectParticipant(second.room, "late");

    expect(second.terminalId).toBe(first.terminalId);
    expect(second.alice.conn.dataFrames).toMatchObject([{ seq: 1 }]);
    expect(late.conn.dataFrames).toMatchObject([{ seq: 1 }]);
    expect(new TextDecoder().decode(late.conn.dataFrames[0]?.payload)).toBe("room-two");
  });
});

async function setupOpenTerminal(ctx = new RoomTestContext()): Promise<{
  ctx: RoomTestContext;
  room: TestRoom;
  host: HostHandle;
  alice: ParticipantHandle;
  bob: ParticipantHandle;
  terminalId: number;
}> {
  const room = await ctx.createRoom();
  const host = await ctx.connectHost(room, "h");
  const alice = await ctx.connectParticipant(room, "alice");
  const bob = await ctx.connectParticipant(room, "bob");
  const terminalId = await ctx.openTerminal(alice, host);
  return { ctx, room, host, alice, bob, terminalId };
}

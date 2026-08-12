import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../ports/policy.js";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("broadcastTerminalOutput — 역할: 출력 팬아웃과 느린 참여자 격리", () => {
  it("host 출력이 참여자 전원에게 서버가 부여한 seq로 전달된다", () => {
    const { alice, bob, host, terminalId } = setupOpenTerminal();

    host.sendOutput(terminalId, 41, "first");
    host.sendOutput(terminalId, 3, "second");

    expect(alice.conn.dataFrames).toMatchObject([
      { kind: "output", terminalId, seq: 1 },
      { kind: "output", terminalId, seq: 2 },
    ]);
    expect(bob.conn.dataFrames).toMatchObject([
      { kind: "output", terminalId, seq: 1 },
      { kind: "output", terminalId, seq: 2 },
    ]);
  });

  it("송신 버퍼가 임계 이상인 참여자에게만 출력을 드롭한다", () => {
    const { alice, bob, host, terminalId } = setupOpenTerminal();
    bob.conn.bufferedBytesValue = DEFAULT_POLICY.sendBufferDropThresholdBytes;

    host.sendOutput(terminalId, 1, "hi");

    expect(alice.conn.dataFrames).toHaveLength(1);
    expect(bob.conn.dataFrames).toHaveLength(0);
  });

  it("드롭된 참여자의 버퍼가 회복되면 sync와 output-gap 뒤 스트림을 재개한다", () => {
    const { bob, host, terminalId } = setupOpenTerminal();
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
    const recoveryMessages = bob.conn.messages.filter(
      (message) => message.type === "sync" || message.type === "output-gap",
    );
    expect(recoveryMessages.map((message) => message.type)).toEqual(["sync", "output-gap"]);
    expect(bob.conn.dataFrames).toMatchObject([{ kind: "output", terminalId, seq: 3 }]);
  });

  it("스크롤백에서 프레임이 퇴출돼도 서버 seq는 단조 증가한다", () => {
    const ctx = new RoomTestContext({ policy: { scrollbackBytesPerTerminal: 1 } });
    const { alice, host, terminalId } = setupOpenTerminal(ctx);

    host.sendOutput(terminalId, 100, "oversized");
    host.sendOutput(terminalId, 100, "x");

    expect(alice.conn.dataFrames).toMatchObject([{ seq: 1 }, { seq: 2 }]);
  });

  it("다른 host는 소유하지 않은 터미널의 출력을 주입할 수 없다", () => {
    const { alice, ctx, room, terminalId } = setupOpenTerminal();
    const attacker = ctx.connectHost(room, "attacker");

    attacker.sendOutput(terminalId, 1, "spoofed");

    expect(alice.conn.dataFrames).toEqual([]);
    expectMessageToMatch(attacker.conn.messages, "error", { code: "bad-message" });
  });

  it("같은 terminalId를 쓰는 다른 Room의 seq와 스크롤백을 공유하지 않는다", () => {
    const ctx = new RoomTestContext();
    const first = setupOpenTerminal(ctx);
    first.host.sendOutput(first.terminalId, 1, "room-one");
    const second = setupOpenTerminal(ctx);

    second.host.sendOutput(second.terminalId, 1, "room-two");
    const late = ctx.connectParticipant(second.room, "late");

    expect(second.terminalId).toBe(first.terminalId);
    expect(second.alice.conn.dataFrames).toMatchObject([{ seq: 1 }]);
    expect(late.conn.dataFrames).toMatchObject([{ seq: 1 }]);
    expect(new TextDecoder().decode(late.conn.dataFrames[0]?.payload)).toBe("room-two");
  });
});

function setupOpenTerminal(ctx = new RoomTestContext()): {
  ctx: RoomTestContext;
  room: { roomId: string; token: string };
  host: ReturnType<RoomTestContext["connectHost"]>;
  alice: ReturnType<RoomTestContext["connectParticipant"]>;
  bob: ReturnType<RoomTestContext["connectParticipant"]>;
  terminalId: number;
} {
  const room = ctx.createRoom();
  const host = ctx.connectHost(room, "h");
  const alice = ctx.connectParticipant(room, "alice");
  const bob = ctx.connectParticipant(room, "bob");
  alice.send({ type: "open-terminal-request", hostId: host.hostId });
  const open = host.conn.messages.find(
    (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
      message.type === "open-terminal",
  );
  if (!open) throw new Error("터미널이 열리지 않았다");
  host.send({ type: "terminal-opened", terminalId: open.terminalId });
  return { ctx, room, host, alice, bob, terminalId: open.terminalId };
}

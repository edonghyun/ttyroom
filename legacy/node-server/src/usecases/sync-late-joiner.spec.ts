import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext, type TestRoom } from "../test/room-test-context.js";

describe("syncLateJoiner — 역할: 늦은 합류자의 화면 복원", () => {
  it("합류하면 기존 출력이 스크롤백에서 재생되고 sync로 끝난다", async () => {
    const { ctx, room, terminalId } = await setupWithOutput();

    const carol = await ctx.connectParticipant(room, "carol");

    expect(carol.conn.dataFrames).toMatchObject([{ kind: "output", terminalId, seq: 1 }]);
    expectMessageToMatch(carol.conn.messages, "sync", {
      terminalId,
      seq: 1,
    });
  });

  it("welcome이 replay보다 먼저 도착하고 sync가 해당 터미널 replay를 끝낸다", async () => {
    const { ctx, room, terminalId } = await setupWithOutput();

    const carol = await ctx.connectParticipant(room, "carol");

    const restoration = carol.conn.arrivalOrder.filter(
      (arrival) =>
        (arrival.kind === "message" &&
          (arrival.message.type === "welcome" ||
            (arrival.message.type === "sync" && arrival.message.terminalId === terminalId))) ||
        (arrival.kind === "data" && arrival.frame.terminalId === terminalId),
    );
    expect(
      restoration.map((arrival) => (arrival.kind === "message" ? arrival.message.type : "data")),
    ).toEqual(["welcome", "data", "sync"]);
  });

  it("출력이 없던 열린 터미널은 replay 없이 sync(seq:0)만 보낸다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    const terminalId = await ctx.openTerminal(alice, host);

    const carol = await ctx.connectParticipant(room, "carol");

    expect(carol.conn.dataFrames).toEqual([]);
    expectMessageToMatch(carol.conn.messages, "sync", {
      terminalId,
      seq: 0,
    });
  });
});

async function setupWithOutput(): Promise<{
  ctx: RoomTestContext;
  room: TestRoom;
  terminalId: number;
}> {
  const ctx = new RoomTestContext();
  const room = await ctx.createRoom();
  const host = await ctx.connectHost(room, "h");
  const alice = await ctx.connectParticipant(room, "alice");
  const terminalId = await ctx.openTerminal(alice, host);
  host.sendOutput(terminalId, 99, "old-output");
  return { ctx, room, terminalId };
}

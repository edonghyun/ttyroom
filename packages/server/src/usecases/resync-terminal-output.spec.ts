import { describe, expect, it } from "vitest";
import { RoomTestContext } from "../test/room-test-context.js";

describe("resyncTerminalOutput — 역할: output-gap 이후 한 terminal의 scrollback 복구", () => {
  it("요청한 terminal의 retained frame만 replay하고 마지막 seq의 sync로 끝낸다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "alice");
    const first = await ctx.openTerminal(alice, host);
    const second = await ctx.openTerminal(alice, host);
    host.sendOutput(first, 1, "first-output");
    host.sendOutput(second, 1, "second-output");
    alice.conn.dataFrames.length = 0;
    alice.conn.arrivalOrder.length = 0;

    await alice.send({ type: "resync-output-request", terminalId: first });

    expect(alice.conn.dataFrames).toMatchObject([{ kind: "output", terminalId: first, seq: 1 }]);
    expect(
      alice.conn.arrivalOrder.map((arrival) =>
        arrival.kind === "data" ? `data:${arrival.frame.terminalId}` : arrival.message.type,
      ),
    ).toEqual([`data:${first}`, "sync"]);
    expect(alice.conn.messages.at(-1)).toEqual({ type: "sync", terminalId: first, seq: 1 });
  });

  it("없는 terminal 요청은 typed 사유로 거절한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const alice = await ctx.connectParticipant(room, "alice");

    await alice.send({ type: "resync-output-request", terminalId: 999 });

    expect(alice.conn.messages.at(-1)).toEqual({
      type: "terminal-request-rejected",
      request: "resync-output",
      terminalId: 999,
      reason: "terminal-not-found",
    });
  });
});

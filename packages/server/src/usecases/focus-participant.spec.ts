import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("focusParticipant — 역할: 참가자의 현재 terminal focus를 Room에 공유", () => {
  it("focus와 blur를 Room 전체에 방송하고 이후 welcome snapshot에 보존한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "Alice");
    const bob = await ctx.connectParticipant(room, "Bob");
    const terminalId = await ctx.openTerminal(alice, host);

    await alice.send({ type: "focus-terminal", terminalId });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: {
        kind: "participant-focus-changed",
        clientId: alice.clientId,
        focusedTerminalId: terminalId,
      },
    });
    const observer = await ctx.connectParticipant(room, "Observer");
    expect(observer.conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          participants: expect.arrayContaining([
            expect.objectContaining({
              clientId: alice.clientId,
              focusedTerminalId: terminalId,
            }),
          ]),
        }),
      }),
    );

    await alice.send({ type: "focus-terminal", terminalId: null });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: {
        kind: "participant-focus-changed",
        clientId: alice.clientId,
        focusedTerminalId: null,
      },
    });
  });

  it("같은 focus 재보고는 방송하지 않고 없는 terminal은 bad-message로 거절한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "Alice");
    const bob = await ctx.connectParticipant(room, "Bob");
    const terminalId = await ctx.openTerminal(alice, host);

    await alice.send({ type: "focus-terminal", terminalId });
    const afterFirst = bob.conn.messages.length;
    await alice.send({ type: "focus-terminal", terminalId });
    expect(bob.conn.messages).toHaveLength(afterFirst);

    await alice.send({ type: "focus-terminal", terminalId: 999 });
    expectMessageToMatch(alice.conn.messages, "error", {
      code: "bad-message",
      message: "존재하지 않는 터미널 focus: 999",
    });
  });
});

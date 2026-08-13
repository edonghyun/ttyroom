import { describe, expect, it } from "vitest";

import { RoomTestContext } from "../test/room-test-context.js";

describe("shareParticipantCursor — 역할: canvas pointer를 같은 Room의 다른 참가자에게만 중계", () => {
  it("이동과 canvas 이탈을 다른 참가자에게 방송하되 snapshot에는 보존하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const alice = await ctx.connectParticipant(room, "Alice");
    const bob = await ctx.connectParticipant(room, "Bob");

    await alice.send({ type: "move-cursor", position: { x: 120.5, y: -48.25 } });
    await alice.send({ type: "move-cursor", position: null });

    expect(bob.conn.messages).toContainEqual({
      type: "participant-cursor",
      clientId: alice.clientId,
      position: { x: 120.5, y: -48.25 },
    });
    expect(bob.conn.messages).toContainEqual({
      type: "participant-cursor",
      clientId: alice.clientId,
      position: null,
    });
    expect(alice.conn.messagesOfType("participant-cursor")).toEqual([]);

    const observer = await ctx.connectParticipant(room, "Observer");
    expect(observer.conn.messagesOfType("participant-cursor")).toEqual([]);
  });
});

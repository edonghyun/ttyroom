import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("RenameTerminal — 역할: participant가 정한 터미널 이름을 Room 전체에 공유", () => {
  it("현재 참가자에게 방송하고 이후 참가자의 welcome snapshot에도 보존한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "Alice");
    const bob = await ctx.connectParticipant(room, "Bob");
    const terminalId = await ctx.openTerminal(alice, host);

    await alice.send({ type: "rename-terminal", terminalId, title: "API logs" });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-renamed", terminalId, title: "API logs" },
    });
    const charlie = await ctx.connectParticipant(room, "Charlie");
    expect(charlie.conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          terminals: [expect.objectContaining({ terminalId, title: "API logs" })],
        }),
      }),
    );
  });
});

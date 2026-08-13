import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("updateTerminalGeometry — 역할: participant의 창 배치를 Room 전체에 공유", () => {
  it("갱신을 참가자 전원에게 방송하고 이후 welcome snapshot에 보존한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "Alice");
    const bob = await ctx.connectParticipant(room, "Bob");
    const terminalId = await ctx.openTerminal(alice, host);
    const geometry = { x: 184, y: 96, width: 760, height: 500 };

    await alice.send({
      type: "update-terminal-geometry",
      terminalId,
      geometry,
    });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-geometry-changed", terminalId, geometry },
    });
    const charlie = await ctx.connectParticipant(room, "Charlie");
    expect(charlie.conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          terminals: [expect.objectContaining({ terminalId, geometry })],
        }),
      }),
    );
  });
});

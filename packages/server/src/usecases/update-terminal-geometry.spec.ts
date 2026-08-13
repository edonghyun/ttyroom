import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("updateTerminalGeometry — 역할: participant의 창 배치를 Room 전체에 공유", () => {
  it("갱신을 참가자 전원에게 방송하고 이후 welcome snapshot에 보존한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host");
    const alice = ctx.connectParticipant(room, "Alice");
    const bob = ctx.connectParticipant(room, "Bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const opened = host.conn.messages.find(
      (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
        message.type === "open-terminal",
    );
    if (!opened) throw new Error("open-terminal 명령이 없다");
    host.send({ type: "terminal-opened", terminalId: opened.terminalId });
    const geometry = { x: 184, y: 96, width: 760, height: 500 };

    alice.send({
      type: "update-terminal-geometry",
      terminalId: opened.terminalId,
      geometry,
    });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-geometry-changed", terminalId: opened.terminalId, geometry },
    });
    expect(ctx.connectParticipant(room, "Charlie").conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          terminals: [expect.objectContaining({ terminalId: opened.terminalId, geometry })],
        }),
      }),
    );
  });
});

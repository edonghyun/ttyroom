import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("RenameTerminal — 역할: participant가 정한 터미널 이름을 Room 전체에 공유", () => {
  it("현재 참가자에게 방송하고 이후 참가자의 welcome snapshot에도 보존한다", () => {
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

    alice.send({ type: "rename-terminal", terminalId: opened.terminalId, title: "API logs" });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-renamed", terminalId: opened.terminalId, title: "API logs" },
    });
    expect(ctx.connectParticipant(room, "Charlie").conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          terminals: [
            expect.objectContaining({ terminalId: opened.terminalId, title: "API logs" }),
          ],
        }),
      }),
    );
  });
});

import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("focusParticipant — 역할: 참가자의 현재 terminal focus를 Room에 공유", () => {
  it("focus와 blur를 Room 전체에 방송하고 이후 welcome snapshot에 보존한다", () => {
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

    alice.send({ type: "focus-terminal", terminalId: opened.terminalId });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: {
        kind: "participant-focus-changed",
        clientId: alice.clientId,
        focusedTerminalId: opened.terminalId,
      },
    });
    expect(ctx.connectParticipant(room, "Observer").conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          participants: expect.arrayContaining([
            expect.objectContaining({
              clientId: alice.clientId,
              focusedTerminalId: opened.terminalId,
            }),
          ]),
        }),
      }),
    );

    alice.send({ type: "focus-terminal", terminalId: null });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: {
        kind: "participant-focus-changed",
        clientId: alice.clientId,
        focusedTerminalId: null,
      },
    });
  });

  it("같은 focus 재보고는 방송하지 않고 없는 terminal은 bad-message로 거절한다", () => {
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

    alice.send({ type: "focus-terminal", terminalId: opened.terminalId });
    const afterFirst = bob.conn.messages.length;
    alice.send({ type: "focus-terminal", terminalId: opened.terminalId });
    expect(bob.conn.messages).toHaveLength(afterFirst);

    alice.send({ type: "focus-terminal", terminalId: 999 });
    expectMessageToMatch(alice.conn.messages, "error", {
      code: "bad-message",
      message: "존재하지 않는 터미널 focus: 999",
    });
  });
});

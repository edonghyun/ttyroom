import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("setTerminalMode — 역할: participant의 명시적 협업 모드 변경", () => {
  it("열린 terminal의 mode를 바꾸고 Room 전체에 변경 event를 방송한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const opened = host.conn.messages.find(
      (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
        message.type === "open-terminal",
    );
    if (!opened) throw new Error("open-terminal 명령이 없다");
    host.send({ type: "terminal-opened", terminalId: opened.terminalId });

    alice.send({ type: "set-terminal-mode", terminalId: opened.terminalId, mode: "shared" });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-mode-changed", terminalId: opened.terminalId, mode: "shared" },
    });
    expect(ctx.connectParticipant(room, "observer").conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          terminals: [expect.objectContaining({ terminalId: opened.terminalId, mode: "shared" })],
        }),
      }),
    );
  });

  it("없는 terminal·종료된 terminal·offline host를 각각 typed 사유로 거절한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host");
    const alice = ctx.connectParticipant(room, "alice");

    alice.send({ type: "set-terminal-mode", terminalId: 999, mode: "shared" });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "set-mode",
      terminalId: 999,
      reason: "terminal-not-found",
    });

    const exited = openTerminal(alice, host);
    host.send({ type: "terminal-closed", terminalId: exited, exitCode: 0 });
    alice.send({ type: "set-terminal-mode", terminalId: exited, mode: "shared" });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "set-mode",
      terminalId: exited,
      reason: "terminal-not-open",
    });

    const offline = openTerminal(alice, host);
    host.disconnect();
    alice.send({ type: "set-terminal-mode", terminalId: offline, mode: "shared" });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "set-mode",
      terminalId: offline,
      reason: "host-offline",
    });
  });
});

function openTerminal(
  participant: ReturnType<RoomTestContext["connectParticipant"]>,
  host: ReturnType<RoomTestContext["connectHost"]>,
): number {
  participant.send({ type: "open-terminal-request", hostId: host.hostId });
  const command = [...host.conn.messages]
    .reverse()
    .find(
      (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
        message.type === "open-terminal",
    );
  if (!command) throw new Error("open-terminal 명령이 없다");
  host.send({ type: "terminal-opened", terminalId: command.terminalId });
  return command.terminalId;
}

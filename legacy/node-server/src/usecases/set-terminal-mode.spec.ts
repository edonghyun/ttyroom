import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("setTerminalMode — 역할: participant의 명시적 협업 모드 변경", () => {
  it("열린 terminal의 mode를 바꾸고 Room 전체에 변경 event를 방송한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "alice");
    const bob = await ctx.connectParticipant(room, "bob");
    const terminalId = await ctx.openTerminal(alice, host);

    await alice.send({ type: "set-terminal-mode", terminalId, mode: "shared" });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-mode-changed", terminalId, mode: "shared" },
    });
    const observer = await ctx.connectParticipant(room, "observer");
    expect(observer.conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          terminals: [expect.objectContaining({ terminalId, mode: "shared" })],
        }),
      }),
    );
  });

  it("없는 terminal·종료된 terminal·offline host를 각각 typed 사유로 거절한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "alice");

    await alice.send({ type: "set-terminal-mode", terminalId: 999, mode: "shared" });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "set-mode",
      terminalId: 999,
      reason: "terminal-not-found",
    });

    const exited = await ctx.openTerminal(alice, host);
    await host.send({ type: "terminal-closed", terminalId: exited, exitCode: 0 });
    await alice.send({ type: "set-terminal-mode", terminalId: exited, mode: "shared" });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "set-mode",
      terminalId: exited,
      reason: "terminal-not-open",
    });

    const offline = await ctx.openTerminal(alice, host);
    await host.disconnect();
    await alice.send({ type: "set-terminal-mode", terminalId: offline, mode: "shared" });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "set-mode",
      terminalId: offline,
      reason: "host-offline",
    });
  });
});

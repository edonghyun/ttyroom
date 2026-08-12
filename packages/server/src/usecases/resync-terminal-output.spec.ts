import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { RoomTestContext } from "../test/room-test-context.js";

describe("resyncTerminalOutput — 역할: output-gap 이후 한 terminal의 scrollback 복구", () => {
  it("요청한 terminal의 retained frame만 replay하고 마지막 seq의 sync로 끝낸다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host");
    const alice = ctx.connectParticipant(room, "alice");
    const first = openTerminal(alice, host);
    const second = openTerminal(alice, host);
    host.sendOutput(first, 1, "first-output");
    host.sendOutput(second, 1, "second-output");
    alice.conn.dataFrames.length = 0;
    alice.conn.arrivalOrder.length = 0;

    alice.send({ type: "resync-output-request", terminalId: first });

    expect(alice.conn.dataFrames).toMatchObject([{ kind: "output", terminalId: first, seq: 1 }]);
    expect(
      alice.conn.arrivalOrder.map((arrival) =>
        arrival.kind === "data" ? `data:${arrival.frame.terminalId}` : arrival.message.type,
      ),
    ).toEqual([`data:${first}`, "sync"]);
    expect(alice.conn.messages.at(-1)).toEqual({ type: "sync", terminalId: first, seq: 1 });
  });

  it("없는 terminal 요청은 typed 사유로 거절한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");

    alice.send({ type: "resync-output-request", terminalId: 999 });

    expect(alice.conn.messages.at(-1)).toEqual({
      type: "terminal-request-rejected",
      request: "resync-output",
      terminalId: 999,
      reason: "terminal-not-found",
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

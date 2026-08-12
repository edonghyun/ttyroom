import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("syncLateJoiner — 역할: 늦은 합류자의 화면 복원", () => {
  it("합류하면 기존 출력이 스크롤백에서 재생되고 sync로 끝난다", () => {
    const { ctx, room, terminalId } = setupWithOutput();

    const carol = ctx.connectParticipant(room, "carol");

    expect(carol.conn.dataFrames).toMatchObject([{ kind: "output", terminalId, seq: 1 }]);
    expectMessageToMatch(carol.conn.messages, "sync", {
      terminalId,
      seq: 1,
    });
  });

  it("welcome이 replay보다 먼저 도착하고 sync가 해당 터미널 replay를 끝낸다", () => {
    const { ctx, room, terminalId } = setupWithOutput();

    const carol = ctx.connectParticipant(room, "carol");

    const restoration = carol.conn.arrivalOrder.filter(
      (arrival) =>
        (arrival.kind === "message" &&
          (arrival.message.type === "welcome" ||
            (arrival.message.type === "sync" && arrival.message.terminalId === terminalId))) ||
        (arrival.kind === "data" && arrival.frame.terminalId === terminalId),
    );
    expect(
      restoration.map((arrival) => (arrival.kind === "message" ? arrival.message.type : "data")),
    ).toEqual(["welcome", "data", "sync"]);
  });

  it("출력이 없던 열린 터미널은 replay 없이 sync(seq:0)만 보낸다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const open = host.conn.messages.find(
      (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
        message.type === "open-terminal",
    );
    if (!open) throw new Error("터미널이 열리지 않았다");
    host.send({ type: "terminal-opened", terminalId: open.terminalId });

    const carol = ctx.connectParticipant(room, "carol");

    expect(carol.conn.dataFrames).toEqual([]);
    expectMessageToMatch(carol.conn.messages, "sync", {
      terminalId: open.terminalId,
      seq: 0,
    });
  });
});

function setupWithOutput(): {
  ctx: RoomTestContext;
  room: { roomId: string; token: string };
  terminalId: number;
} {
  const ctx = new RoomTestContext();
  const room = ctx.createRoom();
  const host = ctx.connectHost(room, "h");
  const alice = ctx.connectParticipant(room, "alice");
  alice.send({ type: "open-terminal-request", hostId: host.hostId });
  const open = host.conn.messages.find(
    (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
      message.type === "open-terminal",
  );
  if (!open) throw new Error("터미널이 열리지 않았다");
  host.send({ type: "terminal-opened", terminalId: open.terminalId });
  host.sendOutput(open.terminalId, 99, "old-output");
  return { ctx, room, terminalId: open.terminalId };
}

import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("updateHostInputState — 역할: Host Kill Switch 상태의 서버 projection", () => {
  it("host 보고를 snapshot에 반영하고 Room 전체에 변경 event를 방송한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host");
    const alice = ctx.connectParticipant(room, "alice");

    host.send({ type: "host-input-state", remoteInputAllowed: false });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: {
        kind: "host-input-state-changed",
        hostId: host.hostId,
        remoteInputAllowed: false,
      },
    });
    expect(ctx.connectParticipant(room, "observer").conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          hosts: [expect.objectContaining({ hostId: host.hostId, remoteInputAllowed: false })],
        }),
      }),
    );
  });

  it("동일 상태 재보고는 event를 중복 방송하지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host");
    const alice = ctx.connectParticipant(room, "alice");

    host.send({ type: "host-input-state", remoteInputAllowed: false });
    host.send({ type: "host-input-state", remoteInputAllowed: false });

    expect(
      alice.conn.messages.filter(
        (message) =>
          message.type === "room-event" && message.event.kind === "host-input-state-changed",
      ),
    ).toHaveLength(1);
  });
});

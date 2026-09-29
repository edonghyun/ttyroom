import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RecordingRoomRepository } from "../test/recording-room-repository.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("updateHostInputState — 역할: Host Kill Switch 상태의 서버 projection", () => {
  it("host 보고를 snapshot에 반영하고 Room 전체에 변경 event를 방송한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "alice");

    await host.send({ type: "host-input-state", remoteInputAllowed: false });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: {
        kind: "host-input-state-changed",
        hostId: host.hostId,
        remoteInputAllowed: false,
      },
    });
    const observer = await ctx.connectParticipant(room, "observer");
    expect(observer.conn.messages).toContainEqual(
      expect.objectContaining({
        type: "welcome",
        snapshot: expect.objectContaining({
          hosts: [expect.objectContaining({ hostId: host.hostId, remoteInputAllowed: false })],
        }),
      }),
    );
  });

  it("동일 상태 재보고는 event를 중복 방송하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "alice");

    await host.send({ type: "host-input-state", remoteInputAllowed: false });
    await host.send({ type: "host-input-state", remoteInputAllowed: false });

    expect(alice.conn.roomEventsOfKind("host-input-state-changed")).toHaveLength(1);
  });

  it("inventory 저장과 겹친 Kill Switch 보고를 Room 명령 순서대로 반영한다", async () => {
    const repository = new RecordingRoomRepository();
    const ctx = new RoomTestContext({ repository });
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const save = repository.deferNextSave();

    const reconciling = host.send({
      type: "host-inventory",
      terminals: [
        {
          terminalId: 7,
          runtimeId: "runtime-7",
          firstRetainedSeq: 0,
          lastOutputSeq: 0,
        },
      ],
    });
    await save.started;
    const enablingInput = host.send({ type: "host-input-state", remoteInputAllowed: true });

    save.release();
    await Promise.all([reconciling, enablingInput]);

    expect(ctx.snapshot(room)?.hosts).toContainEqual(
      expect.objectContaining({ hostId: host.hostId, remoteInputAllowed: true }),
    );
  });
});

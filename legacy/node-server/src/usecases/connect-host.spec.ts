import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RecordingRoomRepository } from "../test/recording-room-repository.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("connectHost — 역할: Connector hello 처리와 Host 등록", () => {
  it("host hello로 Room에 host가 등록되고 참여자에게 host-connected가 브로드캐스트된다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const alice = await ctx.connectParticipant(room, "alice");

    await ctx.connectHost(room, "동현-Mac");

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "host-connected", host: { name: "동현-Mac", online: true } },
    });
  });

  it("같은 hostId 재접속은 host를 online으로 복귀시킨다 (중복 등록 없음)", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "동현-Mac");
    await host.disconnect();

    const again = await ctx.connectHost(room, "동현-Mac", host.hostId);

    expectMessageToMatch(again.conn.messages, "host-ready", {
      terminals: [],
    });
  });

  it("inventory runtime 충돌은 Connector에 close-terminal을 보내 고아 PTY를 제거한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "동현-Mac");
    const alice = await ctx.connectParticipant(room, "alice");
    const terminalId = await ctx.openTerminal(alice, host, "runtime-original");
    host.conn.clear();

    await host.send({
      type: "host-inventory",
      terminals: [
        {
          terminalId,
          runtimeId: "runtime-conflict",
          firstRetainedSeq: 0,
          lastOutputSeq: 0,
        },
      ],
    });

    expectMessageToMatch(host.conn.messages, "close-terminal", { terminalId });
  });

  it("같은 hostId의 새 연결은 이전 세션을 대체해 이후 명령이 새 연결로만 간다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const stale = await ctx.connectHost(room, "동현-Mac", "host-1");
    const fresh = await ctx.connectHost(room, "동현-Mac", "host-1");
    const alice = await ctx.connectParticipant(room, "alice");

    await alice.send({ type: "open-terminal-request", hostId: "host-1" });

    expect(stale.conn.closed).toBe(true);
    expect(stale.conn.messagesOfType("open-terminal")).toEqual([]);
    expect(fresh.conn.messagesOfType("open-terminal")).toHaveLength(1);
  });

  it("같은 clientId의 participant 입장은 host 세션을 대체하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host", "same-id");
    const participant = await ctx.connectParticipant(room, "participant", "same-id");

    await participant.send({ type: "open-terminal-request", hostId: host.hostId });

    expect(host.conn.closed).toBe(false);
    expect(host.conn.messagesOfType("open-terminal")).toHaveLength(1);
  });

  it("같은 clientId의 host 입장은 participant 세션을 대체하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const participant = await ctx.connectParticipant(room, "participant", "same-id");

    await ctx.connectHost(room, "host", "same-id");

    expect(participant.conn.closed).toBe(false);
    expectMessageToMatch(participant.conn.messages, "room-event", {
      event: { kind: "host-connected", host: { hostId: "same-id" } },
    });
  });

  it("같은 hostId가 저장 대기 중 동시에 연결돼도 마지막 연결 하나만 남긴다", async () => {
    const repository = new RecordingRoomRepository();
    repository.delayEverySaveUntilNextTurn();
    const ctx = new RoomTestContext({ repository });
    const room = await ctx.createRoom();

    const [first, second] = await Promise.all([
      ctx.connectHost(room, "동현-Mac", "host-1"),
      ctx.connectHost(room, "동현-Mac", "host-1"),
    ]);

    expect(first.conn.closed).toBe(true);
    expect(second.conn.closed).toBe(false);
  });
});

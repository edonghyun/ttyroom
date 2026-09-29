import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../ports/policy.js";
import { expectMessageToMatch } from "../test/matchers.js";
import { RecordingRoomRepository } from "../test/recording-room-repository.js";
import {
  RoomTestContext,
  type HostHandle,
  type ParticipantHandle,
  type TestRoom,
} from "../test/room-test-context.js";

describe("handleDisconnect — 역할: 단절의 유예 처리와 복원", () => {
  it("참여자 단절 후 유예 내 같은 clientId 재접속이면 타이머가 취소되고 임대가 유지된다", async () => {
    const { alice, ctx, room, terminalId } = await setupWithLease();

    await alice.disconnect();
    expect(ctx.clock.pendingCount()).toBe(1);
    await ctx.clock.advance(DEFAULT_POLICY.participantGraceMs - 1);
    const aliceAgain = await ctx.connectParticipant(room, "alice", alice.clientId);
    expect(ctx.clock.pendingCount()).toBe(0);
    await ctx.clock.advance(10_000);

    expectMessageToMatch(aliceAgain.conn.messages, "welcome", {
      snapshot: { leases: [{ terminalId, holderClientId: alice.clientId }] },
    });
  });

  it("참여자 유예가 만료되면 임대를 해제하고 lease-released와 participant-left를 브로드캐스트한다", async () => {
    const { alice, bob, ctx, terminalId } = await setupWithLease();
    bob.conn.clear();

    await alice.disconnect();
    await ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "lease-released", terminalId },
    });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "participant-left", clientId: alice.clientId },
    });
  });

  it("host 단절 즉시 host-offline을 브로드캐스트하고 터미널은 유예 동안 남긴다", async () => {
    const { bob, ctx, host, room, terminalId } = await setupWithLease();
    bob.conn.clear();

    await host.disconnect();

    expect(ctx.clock.pendingCount()).toBe(1);
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "host-offline", hostId: host.hostId },
    });
    const observer = await ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: {
        hosts: [{ hostId: host.hostId, online: false }],
        terminals: [{ terminalId, hostId: host.hostId }],
      },
    });
  });

  it("host 유예가 만료되면 host-removed와 터미널별 terminal-closed를 브로드캐스트한다", async () => {
    const { bob, ctx, host, room, terminalId } = await setupWithLease();
    await host.disconnect();
    bob.conn.clear();

    await ctx.clock.advance(DEFAULT_POLICY.hostGraceMs);

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "host-removed", hostId: host.hostId },
    });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-closed", terminalId, exitCode: null },
    });
    const observer = await ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { hosts: [], terminals: [], leases: [] },
    });
  });

  it("host가 유예 내 재접속하면 제거 타이머를 취소하고 online으로 복원한다", async () => {
    const { bob, ctx, host, room, terminalId } = await setupWithLease();
    await host.disconnect();
    bob.conn.clear();

    const again = await ctx.connectHost(room, "h", host.hostId);

    expect(ctx.clock.pendingCount()).toBe(0);
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "host-connected", host: { hostId: host.hostId, online: true } },
    });
    await ctx.clock.advance(DEFAULT_POLICY.hostGraceMs + 1);
    expectMessageToMatch(again.conn.messages, "host-ready", {
      terminals: [{ terminalId }],
    });
  });

  it("모든 세션의 유예가 끝나 Room이 비면 소멸해 재접속을 room-not-found로 거부한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const alice = await ctx.connectParticipant(room, "alice");

    await alice.disconnect();
    await ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);
    const tooLate = await ctx.connectParticipant(room, "alice", alice.clientId);

    expectMessageToMatch(tooLate.conn.messages, "error", { code: "room-not-found" });
  });

  it("host만 있던 Room도 host 유예가 끝나면 소멸한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host-only");

    await host.disconnect();
    await ctx.clock.advance(DEFAULT_POLICY.hostGraceMs);
    const tooLate = await ctx.connectHost(room, "host-only", host.hostId);

    expectMessageToMatch(tooLate.conn.messages, "error", { code: "room-not-found" });
  });

  it("참여자 유예가 먼저 끝나도 아직 host 유예 중이면 Room을 보존한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await host.disconnect();
    await alice.disconnect();

    await ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);
    const restored = await ctx.connectHost(room, "h", host.hostId);

    expectMessageToMatch(restored.conn.messages, "host-ready", {
      terminals: [],
    });
  });

  it("유예 만료 작업 실패를 보고하고 rejection을 소비하며 Room을 보존한다", async () => {
    const repository = new RecordingRoomRepository();
    const errors: unknown[] = [];
    const ctx = new RoomTestContext({
      repository,
      onBackgroundError: (error) => errors.push(error),
    });
    const room = await ctx.createRoom();
    const alice = await ctx.connectParticipant(room, "alice");
    const deleteError = new Error("delete failed");
    repository.failDeletesWith(deleteError);
    await alice.disconnect();

    await expect(ctx.clock.advance(DEFAULT_POLICY.participantGraceMs)).resolves.toBeUndefined();

    expect(errors).toEqual([deleteError]);
    // The live participant expiry already committed before the separate room delete failed.
    expect(ctx.snapshot(room)).toMatchObject({ participants: [], leases: [] });
    expect(ctx.core.backgroundTaskCount()).toBe(0);
  });

  it("종료는 실행 중인 유예 작업이 끝날 때까지 기다린다", async () => {
    const repository = new RecordingRoomRepository();
    const ctx = new RoomTestContext({ repository });
    const room = await ctx.createRoom();
    const alice = await ctx.connectParticipant(room, "alice");
    const deletion = repository.deferNextDelete();
    await alice.disconnect();

    const expiration = ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);
    await deletion.started;
    let closed = false;
    const closing = ctx.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    deletion.release();
    await Promise.all([expiration, closing]);
    expect(closed).toBe(true);
  });
});

async function setupWithLease(): Promise<{
  ctx: RoomTestContext;
  room: TestRoom;
  host: HostHandle;
  alice: ParticipantHandle;
  bob: ParticipantHandle;
  terminalId: number;
}> {
  const ctx = new RoomTestContext();
  const room = await ctx.createRoom();
  const host = await ctx.connectHost(room, "h");
  const alice = await ctx.connectParticipant(room, "alice");
  const bob = await ctx.connectParticipant(room, "bob");
  const terminalId = await ctx.openTerminal(alice, host);
  await ctx.acquireLease(alice, terminalId);
  return { ctx, room, host, alice, bob, terminalId };
}

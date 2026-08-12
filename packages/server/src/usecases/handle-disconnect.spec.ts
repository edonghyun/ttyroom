import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../ports/policy.js";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("handleDisconnect — 역할: 단절의 유예 처리와 복원", () => {
  it("참여자 단절 후 유예 내 같은 clientId 재접속이면 타이머가 취소되고 임대가 유지된다", () => {
    const { alice, ctx, room, terminalId } = setupWithLease();

    alice.disconnect();
    expect(ctx.clock.pendingCount()).toBe(1);
    ctx.clock.advance(DEFAULT_POLICY.participantGraceMs - 1);
    const aliceAgain = ctx.connectParticipant(room, "alice", alice.clientId);
    expect(ctx.clock.pendingCount()).toBe(0);
    ctx.clock.advance(10_000);

    expectMessageToMatch(aliceAgain.conn.messages, "welcome", {
      snapshot: { leases: [{ terminalId, holderClientId: alice.clientId }] },
    });
  });

  it("참여자 유예가 만료되면 임대를 해제하고 lease-released와 participant-left를 브로드캐스트한다", () => {
    const { alice, bob, ctx, terminalId } = setupWithLease();
    bob.conn.messages.length = 0;

    alice.disconnect();
    ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "lease-released", terminalId },
    });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "participant-left", clientId: alice.clientId },
    });
  });

  it("host 단절 즉시 host-offline을 브로드캐스트하고 터미널은 유예 동안 남긴다", () => {
    const { bob, ctx, host, room, terminalId } = setupWithLease();
    bob.conn.messages.length = 0;

    host.disconnect();

    expect(ctx.clock.pendingCount()).toBe(1);
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "host-offline", hostId: host.hostId },
    });
    const observer = ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: {
        hosts: [{ hostId: host.hostId, online: false }],
        terminals: [{ terminalId, hostId: host.hostId }],
      },
    });
  });

  it("host 유예가 만료되면 host-removed와 터미널별 terminal-closed를 브로드캐스트한다", () => {
    const { bob, ctx, host, room, terminalId } = setupWithLease();
    host.disconnect();
    bob.conn.messages.length = 0;

    ctx.clock.advance(DEFAULT_POLICY.hostGraceMs);

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "host-removed", hostId: host.hostId },
    });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "terminal-closed", terminalId, exitCode: null },
    });
    const observer = ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { hosts: [], terminals: [], leases: [] },
    });
  });

  it("host가 유예 내 재접속하면 제거 타이머를 취소하고 online으로 복원한다", () => {
    const { bob, ctx, host, room, terminalId } = setupWithLease();
    host.disconnect();
    bob.conn.messages.length = 0;

    const again = ctx.connectHost(room, "h", host.hostId);

    expect(ctx.clock.pendingCount()).toBe(0);
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "host-connected", host: { hostId: host.hostId, online: true } },
    });
    ctx.clock.advance(DEFAULT_POLICY.hostGraceMs + 1);
    expectMessageToMatch(again.conn.messages, "welcome", {
      snapshot: {
        hosts: [{ hostId: host.hostId, online: true }],
        terminals: [{ terminalId, hostId: host.hostId }],
      },
    });
  });

  it("모든 세션의 유예가 끝나 Room이 비면 소멸해 재접속을 room-not-found로 거부한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");

    alice.disconnect();
    ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);
    const tooLate = ctx.connectParticipant(room, "alice", alice.clientId);

    expectMessageToMatch(tooLate.conn.messages, "error", { code: "room-not-found" });
  });

  it("host만 있던 Room도 host 유예가 끝나면 소멸한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host-only");

    host.disconnect();
    ctx.clock.advance(DEFAULT_POLICY.hostGraceMs);
    const tooLate = ctx.connectHost(room, "host-only", host.hostId);

    expectMessageToMatch(tooLate.conn.messages, "error", { code: "room-not-found" });
  });

  it("참여자 유예가 먼저 끝나도 아직 host 유예 중이면 Room을 보존한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    host.disconnect();
    alice.disconnect();

    ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);
    const restored = ctx.connectHost(room, "h", host.hostId);

    expectMessageToMatch(restored.conn.messages, "welcome", {
      snapshot: { hosts: [{ hostId: host.hostId, online: true }] },
    });
  });
});

function setupWithLease(): {
  ctx: RoomTestContext;
  room: { roomId: string; token: string };
  host: ReturnType<RoomTestContext["connectHost"]>;
  alice: ReturnType<RoomTestContext["connectParticipant"]>;
  bob: ReturnType<RoomTestContext["connectParticipant"]>;
  terminalId: number;
} {
  const ctx = new RoomTestContext();
  const room = ctx.createRoom();
  const host = ctx.connectHost(room, "h");
  const alice = ctx.connectParticipant(room, "alice");
  const bob = ctx.connectParticipant(room, "bob");
  alice.send({ type: "open-terminal-request", hostId: host.hostId });
  const open = host.conn.messages.find(
    (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
      message.type === "open-terminal",
  );
  if (!open) throw new Error("터미널이 열리지 않았다");
  host.send({ type: "terminal-opened", terminalId: open.terminalId });
  alice.send({ type: "acquire-lease", terminalId: open.terminalId });
  return { ctx, room, host, alice, bob, terminalId: open.terminalId };
}

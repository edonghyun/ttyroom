import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import {
  RoomTestContext,
  type HostHandle,
  type ParticipantHandle,
  type TestRoom,
} from "../test/room-test-context.js";

describe("acquireLease — 역할: 입력권 요청의 처리와 전파", () => {
  it("빈 터미널 요청자는 granted lease-result를 받고 전원이 lease-granted를 받는다", async () => {
    const { alice, bob, terminalId } = await openTerminalScenario();

    await alice.send({ type: "acquire-lease", terminalId });

    expectMessageToMatch(alice.conn.messages, "lease-result", {
      terminalId,
      result: { kind: "granted" },
    });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: {
        kind: "lease-granted",
        lease: { terminalId, holderClientId: alice.clientId },
      },
    });
  });

  it("점유된 터미널 요청자는 denied와 현재 소유자를 받고 브로드캐스트는 없다", async () => {
    const { alice, bob, ctx, terminalId } = await openTerminalScenario();
    await ctx.acquireLease(alice, terminalId);
    bob.conn.clear();

    await bob.send({ type: "acquire-lease", terminalId });

    expectMessageToMatch(bob.conn.messages, "lease-result", {
      terminalId,
      result: { kind: "denied", holderClientId: alice.clientId },
    });
    expect(bob.conn.messagesOfType("room-event")).toEqual([]);
  });

  it("다른 터미널 획득 시 이전 임대의 lease-released가 lease-granted보다 먼저 브로드캐스트된다", async () => {
    const { alice, bob, ctx, host, terminalId: firstTerminalId } = await openTerminalScenario();
    const secondTerminalId = await ctx.openTerminal(alice, host);
    await ctx.acquireLease(alice, firstTerminalId);
    bob.conn.clear();

    await alice.send({ type: "acquire-lease", terminalId: secondTerminalId });

    const leaseEvents = bob.conn
      .messagesOfType("room-event")
      .filter(
        (message) =>
          message.event.kind === "lease-released" || message.event.kind === "lease-granted",
      );
    expect(leaseEvents).toMatchObject([
      { event: { kind: "lease-released", terminalId: firstTerminalId } },
      { event: { kind: "lease-granted", lease: { terminalId: secondTerminalId } } },
    ]);
  });

  it("같은 acquire가 두 번 도착하면 같은 leaseId로 재응답하고 상태 이벤트는 중복하지 않는다", async () => {
    const { alice, terminalId } = await openTerminalScenario();

    await alice.send({ type: "acquire-lease", terminalId });
    await alice.send({ type: "acquire-lease", terminalId });

    const results = alice.conn.messagesOfType("lease-result");
    expect(results).toHaveLength(2);
    expect(results[0]?.result).toEqual(results[1]?.result);
    expect(
      alice.conn
        .messagesOfType("room-event")
        .filter((message) => message.event.kind === "lease-granted"),
    ).toHaveLength(1);
  });

  it("release-lease는 현재 소유자의 현재 leaseId만 성공하고 lease-released를 브로드캐스트한다", async () => {
    const { alice, bob, ctx, room, terminalId } = await openTerminalScenario();
    const leaseId = await ctx.acquireLease(alice, terminalId);
    bob.conn.clear();

    await alice.send({ type: "release-lease", terminalId, leaseId });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "lease-released", terminalId },
    });
    const observer = await ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", { snapshot: { leases: [] } });
  });

  it("틀린 leaseId의 release-lease는 임대를 해제하지 않고 요청자에게만 lease-invalid를 보낸다", async () => {
    const { alice, bob, ctx, room, terminalId } = await openTerminalScenario();
    const leaseId = await ctx.acquireLease(alice, terminalId);
    bob.conn.clear();

    await alice.send({ type: "release-lease", terminalId, leaseId: leaseId + 1 });

    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "not-holder",
    });
    expect(bob.conn.messagesOfType("room-event")).toEqual([]);
    const observer = await ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { leases: [{ terminalId, holderClientId: alice.clientId }] },
    });
  });

  it("종료된 터미널의 acquire는 lease-invalid(terminal-closed)로 거부한다", async () => {
    const { alice, host, terminalId } = await openTerminalScenario();
    await host.send({ type: "terminal-closed", terminalId, exitCode: 0 });

    await alice.send({ type: "acquire-lease", terminalId });

    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "terminal-closed",
    });
  });
});

async function openTerminalScenario(): Promise<{
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
  return { ctx, room, host, alice, bob, terminalId };
}

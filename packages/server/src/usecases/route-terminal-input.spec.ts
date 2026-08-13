import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import {
  RoomTestContext,
  type HostHandle,
  type ParticipantHandle,
  type TestRoom,
} from "../test/room-test-context.js";

describe("routeTerminalInput — 역할: 입력권 검증의 단일 지점", () => {
  it("유효한 임대의 입력 프레임은 해당 host로 그대로 전달된다", async () => {
    const { alice, host, terminalId, leaseId } = await setupWithLease();
    host.allowAgentData();

    alice.sendInput(terminalId, leaseId, "ls\n", 17);

    expect(host.conn.dataFrames).toEqual([
      {
        kind: "input",
        terminalId,
        seq: 17,
        leaseId,
        payload: new TextEncoder().encode("ls\n"),
      },
    ]);
  });

  it("오래된 leaseId의 입력은 폐기되고 보낸 사람만 lease-invalid를 받는다", async () => {
    const { alice, bob, host, terminalId, leaseId } = await setupWithLease();

    alice.sendInput(terminalId, leaseId + 99, "danger\n");

    expect(host.conn.dataFrames).toEqual([]);
    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "not-holder",
    });
    expect(bob.conn.messagesOfType("lease-invalid")).toEqual([]);
  });

  it("host가 오프라인이면 입력을 폐기하고 lease-invalid(terminal-closed)를 보낸다", async () => {
    const { alice, host, terminalId, leaseId } = await setupWithLease();
    await host.disconnect();

    alice.sendInput(terminalId, leaseId, "ls\n");

    expect(host.conn.dataFrames).toEqual([]);
    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "terminal-closed",
    });
  });

  it("host가 원격 입력을 차단하면 유효 lease 입력도 typed 사유로 폐기한다", async () => {
    const { alice, host, terminalId, leaseId } = await setupWithLease();
    host.allowAgentData();

    await host.send({ type: "host-input-state", remoteInputAllowed: false });
    alice.sendInput(terminalId, leaseId, "blocked\n");

    expect(host.conn.dataFrames).toEqual([]);
    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "remote-input-disabled",
    });
  });

  it("shared 터미널은 임대 없이 Room 참여자의 입력을 전달한다", async () => {
    const { ctx, room, bob, host, terminalId } = await setupWithLease();
    await ctx.setTerminalMode(room, terminalId, "shared");
    host.allowAgentData();

    bob.sendInput(terminalId, 0, "pair input\n");

    expect(host.conn.dataFrames).toMatchObject([{ kind: "input", terminalId, leaseId: 0 }]);
  });

  it("malformed 데이터 프레임은 error(bad-message)로 응답한다", async () => {
    const { ctx, alice } = await setupWithLease();

    ctx.core.handleData(alice.conn, new Uint8Array([0xff]));

    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
  });

  it("테스트가 허용하지 않은 Agent 쓰기는 즉시 실패한다 (가드)", async () => {
    const { alice, terminalId, leaseId } = await setupWithLease();

    expect(() => alice.sendInput(terminalId, leaseId, "x")).toThrow(/Unexpected agent write/);
  });
});

async function setupWithLease(): Promise<{
  ctx: RoomTestContext;
  room: TestRoom;
  host: HostHandle;
  alice: ParticipantHandle;
  bob: ParticipantHandle;
  terminalId: number;
  leaseId: number;
}> {
  const ctx = new RoomTestContext();
  const room = await ctx.createRoom();
  const host = await ctx.connectHost(room, "h");
  const alice = await ctx.connectParticipant(room, "alice");
  const bob = await ctx.connectParticipant(room, "bob");
  const terminalId = await ctx.openTerminal(alice, host);
  const leaseId = await ctx.acquireLease(alice, terminalId);
  return {
    ctx,
    room,
    host,
    alice,
    bob,
    terminalId,
    leaseId,
  };
}

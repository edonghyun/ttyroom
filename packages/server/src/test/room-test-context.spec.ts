import { describe, expect, it } from "vitest";
import { RoomTestContext } from "./room-test-context.js";

describe("RoomTestContext — 역할: 실제 배선을 재현하는 테스트 컴포지션 루트", () => {
  it("테스트가 허용하지 않은 Agent 쓰기는 즉시 실패한다 (allowAgentData 가드)", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host-mac");

    expect(() =>
      host.conn.sendData({
        kind: "input",
        terminalId: 1,
        seq: 1,
        leaseId: 1,
        payload: new Uint8Array([0x68]),
      }),
    ).toThrow(/call host\.allowAgentData\(\)/);

    host.allowAgentData();
    expect(() =>
      host.conn.sendData({
        kind: "input",
        terminalId: 1,
        seq: 2,
        leaseId: 1,
        payload: new Uint8Array([0x69]),
      }),
    ).not.toThrow();
  });

  it("가드는 제어 메시지(send)는 막지 않는다 — welcome·이벤트 검증이 평소처럼 가능", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host-mac");

    expect(() => host.conn.send({ type: "sync", terminalId: 1, seq: 0 })).not.toThrow();
  });

  it("터미널 열기와 입력권 획득을 실제 메시지 흐름으로 준비한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host-mac");
    const alice = await ctx.connectParticipant(room, "alice");

    const terminalId = await ctx.openTerminal(alice, host);
    const leaseId = await ctx.acquireLease(alice, terminalId);

    expect(terminalId).toBe(1);
    expect(leaseId).toBeGreaterThan(0);
    expect(alice.conn.lastMessageOfType("lease-result")).toMatchObject({
      terminalId,
      result: { kind: "granted", leaseId },
    });
  });
});

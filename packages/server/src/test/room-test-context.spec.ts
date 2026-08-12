import { describe, expect, it } from "vitest";
import { RoomTestContext } from "./room-test-context.js";

describe("RoomTestContext — 역할: 실제 배선을 재현하는 테스트 컴포지션 루트", () => {
  it("테스트가 허용하지 않은 Agent 쓰기는 즉시 실패한다 (allowAgentData 가드)", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host-mac");

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

  it("가드는 제어 메시지(send)는 막지 않는다 — welcome·이벤트 검증이 평소처럼 가능", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "host-mac");

    expect(() => host.conn.send({ type: "sync", terminalId: 1, seq: 0 })).not.toThrow();
  });
});

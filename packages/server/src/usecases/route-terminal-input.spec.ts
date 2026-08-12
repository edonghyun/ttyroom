import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("routeTerminalInput — 역할: 입력권 검증의 단일 지점", () => {
  it("유효한 임대의 입력 프레임은 해당 host로 그대로 전달된다", () => {
    const { alice, host, terminalId, leaseId } = setupWithLease();
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

  it("오래된 leaseId의 입력은 폐기되고 보낸 사람만 lease-invalid를 받는다", () => {
    const { alice, bob, host, terminalId, leaseId } = setupWithLease();

    alice.sendInput(terminalId, leaseId + 99, "danger\n");

    expect(host.conn.dataFrames).toEqual([]);
    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "not-holder",
    });
    expect(bob.conn.messages.some((message) => message.type === "lease-invalid")).toBe(false);
  });

  it("host가 오프라인이면 입력을 폐기하고 lease-invalid(terminal-closed)를 보낸다", () => {
    const { alice, host, terminalId, leaseId } = setupWithLease();
    host.disconnect();

    alice.sendInput(terminalId, leaseId, "ls\n");

    expect(host.conn.dataFrames).toEqual([]);
    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "terminal-closed",
    });
  });

  it("shared 터미널은 임대 없이 Room 참여자의 입력을 전달한다", () => {
    const { ctx, room, bob, host, terminalId } = setupWithLease();
    ctx.setTerminalMode(room, terminalId, "shared");
    host.allowAgentData();

    bob.sendInput(terminalId, 0, "pair input\n");

    expect(host.conn.dataFrames).toMatchObject([{ kind: "input", terminalId, leaseId: 0 }]);
  });

  it("malformed 데이터 프레임은 error(bad-message)로 응답한다", () => {
    const { ctx, alice } = setupWithLease();

    ctx.core.handleData(alice.conn, new Uint8Array([0xff]));

    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
  });

  it("테스트가 허용하지 않은 Agent 쓰기는 즉시 실패한다 (가드)", () => {
    const { alice, terminalId, leaseId } = setupWithLease();

    expect(() => alice.sendInput(terminalId, leaseId, "x")).toThrow(/Unexpected agent write/);
  });
});

function setupWithLease(): {
  ctx: RoomTestContext;
  room: { roomId: string; token: string };
  host: ReturnType<RoomTestContext["connectHost"]>;
  alice: ReturnType<RoomTestContext["connectParticipant"]>;
  bob: ReturnType<RoomTestContext["connectParticipant"]>;
  terminalId: number;
  leaseId: number;
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
  const result = alice.conn.messages.find(
    (message): message is Extract<ServerMessage, { type: "lease-result" }> =>
      message.type === "lease-result" && message.result.kind === "granted",
  );
  if (!result || result.result.kind !== "granted") throw new Error("임대를 얻지 못했다");
  return {
    ctx,
    room,
    host,
    alice,
    bob,
    terminalId: open.terminalId,
    leaseId: result.result.leaseId,
  };
}

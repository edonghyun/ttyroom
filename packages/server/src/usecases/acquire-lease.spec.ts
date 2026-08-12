import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("acquireLease — 역할: 입력권 요청의 처리와 전파", () => {
  it("빈 터미널 요청자는 granted lease-result를 받고 전원이 lease-granted를 받는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = openTerminalId(host.conn.messages);
    host.send({ type: "terminal-opened", terminalId });

    alice.send({ type: "acquire-lease", terminalId });

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

  it("점유된 터미널 요청자는 denied와 현재 소유자를 받고 브로드캐스트는 없다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = openTerminalId(host.conn.messages);
    host.send({ type: "terminal-opened", terminalId });
    alice.send({ type: "acquire-lease", terminalId });
    bob.conn.messages.length = 0;

    bob.send({ type: "acquire-lease", terminalId });

    expectMessageToMatch(bob.conn.messages, "lease-result", {
      terminalId,
      result: { kind: "denied", holderClientId: alice.clientId },
    });
    expect(bob.conn.messages.some((message) => message.type === "room-event")).toBe(false);
  });

  it("다른 터미널 획득 시 이전 임대의 lease-released가 lease-granted보다 먼저 브로드캐스트된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalIds = host.conn.messages
      .filter(
        (message): message is Extract<ServerMessage, { type: "open-terminal" }> =>
          message.type === "open-terminal",
      )
      .map((message) => message.terminalId);
    const [firstTerminalId, secondTerminalId] = terminalIds;
    if (firstTerminalId === undefined || secondTerminalId === undefined) {
      throw new Error("터미널 2개가 열리지 않았다");
    }
    host.send({ type: "terminal-opened", terminalId: firstTerminalId });
    host.send({ type: "terminal-opened", terminalId: secondTerminalId });
    alice.send({ type: "acquire-lease", terminalId: firstTerminalId });
    bob.conn.messages.length = 0;

    alice.send({ type: "acquire-lease", terminalId: secondTerminalId });

    const leaseEvents = bob.conn.messages.filter(
      (message) =>
        message.type === "room-event" &&
        (message.event.kind === "lease-released" || message.event.kind === "lease-granted"),
    );
    expect(leaseEvents).toMatchObject([
      { event: { kind: "lease-released", terminalId: firstTerminalId } },
      { event: { kind: "lease-granted", lease: { terminalId: secondTerminalId } } },
    ]);
  });

  it("같은 acquire가 두 번 도착하면 같은 leaseId로 재응답하고 상태 이벤트는 중복하지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = openTerminalId(host.conn.messages);
    host.send({ type: "terminal-opened", terminalId });

    alice.send({ type: "acquire-lease", terminalId });
    alice.send({ type: "acquire-lease", terminalId });

    const results = alice.conn.messages.filter(
      (message): message is Extract<ServerMessage, { type: "lease-result" }> =>
        message.type === "lease-result",
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.result).toEqual(results[1]?.result);
    expect(
      alice.conn.messages.filter(
        (message) => message.type === "room-event" && message.event.kind === "lease-granted",
      ),
    ).toHaveLength(1);
  });

  it("release-lease는 현재 소유자의 현재 leaseId만 성공하고 lease-released를 브로드캐스트한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = openTerminalId(host.conn.messages);
    host.send({ type: "terminal-opened", terminalId });
    alice.send({ type: "acquire-lease", terminalId });
    const result = alice.conn.messages.find(
      (message): message is Extract<ServerMessage, { type: "lease-result" }> =>
        message.type === "lease-result" && message.result.kind === "granted",
    );
    if (!result || result.result.kind !== "granted") throw new Error("임대를 얻지 못했다");
    bob.conn.messages.length = 0;

    alice.send({ type: "release-lease", terminalId, leaseId: result.result.leaseId });

    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "lease-released", terminalId },
    });
    const observer = ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", { snapshot: { leases: [] } });
  });

  it("틀린 leaseId의 release-lease는 임대를 해제하지 않고 요청자에게만 lease-invalid를 보낸다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = openTerminalId(host.conn.messages);
    host.send({ type: "terminal-opened", terminalId });
    alice.send({ type: "acquire-lease", terminalId });
    const result = alice.conn.messages.find(
      (message): message is Extract<ServerMessage, { type: "lease-result" }> =>
        message.type === "lease-result" && message.result.kind === "granted",
    );
    if (!result || result.result.kind !== "granted") throw new Error("임대를 얻지 못했다");
    bob.conn.messages.length = 0;

    alice.send({
      type: "release-lease",
      terminalId,
      leaseId: result.result.leaseId + 1,
    });

    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "not-holder",
    });
    expect(bob.conn.messages.some((message) => message.type === "room-event")).toBe(false);
    const observer = ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { leases: [{ terminalId, holderClientId: alice.clientId }] },
    });
  });

  it("종료된 터미널의 acquire는 lease-invalid(terminal-closed)로 거부한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = openTerminalId(host.conn.messages);
    host.send({ type: "terminal-closed", terminalId, exitCode: 0 });

    alice.send({ type: "acquire-lease", terminalId });

    expectMessageToMatch(alice.conn.messages, "lease-invalid", {
      terminalId,
      reason: "terminal-closed",
    });
  });
});

function openTerminalId(messages: ServerMessage[]): number {
  const message = messages.find(
    (candidate): candidate is Extract<ServerMessage, { type: "open-terminal" }> =>
      candidate.type === "open-terminal",
  );
  if (!message) throw new Error("open-terminal 메시지가 없다");
  return message.terminalId;
}

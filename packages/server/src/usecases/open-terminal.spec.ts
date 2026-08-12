import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("openTerminal — 역할: 터미널 생성 요청의 중개", () => {
  it("open-terminal-request는 host에게 open-terminal 명령을 전달한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");

    alice.send({ type: "open-terminal-request", hostId: host.hostId });

    expect(lastMessageOfType(host.conn.messages, "open-terminal")).toMatchObject({
      cols: 80,
      rows: 24,
    });
  });

  it("host가 terminal-opened를 확인하면 참여자 전원에게 terminal-opened 이벤트가 브로드캐스트된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;

    host.send({ type: "terminal-opened", terminalId });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: {
        kind: "terminal-opened",
        terminal: { terminalId, hostId: host.hostId, status: "open" },
      },
    });
  });

  it("같은 terminal-opened 확인이 재도착해도 열린 이벤트를 중복 브로드캐스트하지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;

    host.send({ type: "terminal-opened", terminalId });
    host.send({ type: "terminal-opened", terminalId });

    const openedEvents = alice.conn.messages.filter(
      (message) => message.type === "room-event" && message.event.kind === "terminal-opened",
    );
    expect(openedEvents).toHaveLength(1);
  });

  it("오프라인 host에 대한 요청은 요청자에게만 error(bad-message)를 보낸다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    host.disconnect();

    alice.send({ type: "open-terminal-request", hostId: host.hostId });

    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
    expect(bob.conn.messages.some((message) => message.type === "error")).toBe(false);
  });

  it("host의 terminal-closed는 종료 상태를 반영하고 참여자에게 브로드캐스트한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;

    host.send({ type: "terminal-closed", terminalId, exitCode: 7 });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "terminal-closed", terminalId, exitCode: 7 },
    });
    const observer = ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { terminals: [{ terminalId, status: "exited", exitCode: 7 }] },
    });
  });

  it("같은 terminal-closed가 재도착해도 종료 이벤트를 중복 브로드캐스트하지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;

    host.send({ type: "terminal-closed", terminalId, exitCode: 0 });
    host.send({ type: "terminal-closed", terminalId, exitCode: 0 });

    const closedEvents = alice.conn.messages.filter(
      (message) => message.type === "room-event" && message.event.kind === "terminal-closed",
    );
    expect(closedEvents).toHaveLength(1);
  });

  it("이미 종료된 터미널의 늦은 terminal-opened는 열린 이벤트를 만들지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;

    host.send({ type: "terminal-closed", terminalId, exitCode: 1 });
    host.send({ type: "terminal-opened", terminalId });

    expect(
      alice.conn.messages.some(
        (message) => message.type === "room-event" && message.event.kind === "terminal-opened",
      ),
    ).toBe(false);
  });

  it("host의 terminal-meta는 메타데이터를 반영하고 참여자에게 브로드캐스트한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;
    const meta = { cwd: "/tmp", gitBranch: "main", fgProcess: "zsh" };

    host.send({ type: "terminal-meta", terminalId, meta });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "terminal-meta", terminalId, meta },
    });
    const observer = ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { terminals: [{ terminalId, meta }] },
    });
  });

  it("동일한 terminal-meta 재전송은 이벤트를 중복 브로드캐스트하지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;
    const meta = { cwd: "/tmp", gitBranch: "main", fgProcess: "zsh" };

    host.send({ type: "terminal-meta", terminalId, meta });
    host.send({ type: "terminal-meta", terminalId, meta });

    const metaEvents = alice.conn.messages.filter(
      (message) => message.type === "room-event" && message.event.kind === "terminal-meta",
    );
    expect(metaEvents).toHaveLength(1);
  });

  it("participant의 resize-request는 터미널 host에게 resize 명령으로 전달된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastMessageOfType(host.conn.messages, "open-terminal").terminalId;

    alice.send({ type: "resize-request", terminalId, cols: 132, rows: 43 });

    expect(lastMessageOfType(host.conn.messages, "resize")).toMatchObject({
      terminalId,
      cols: 132,
      rows: 43,
    });
  });

  it("존재하지 않는 터미널 resize는 host에 전달하지 않고 요청자에게만 error를 보낸다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");

    alice.send({ type: "resize-request", terminalId: 999, cols: 80, rows: 24 });

    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
    expect(host.conn.messages.some((message) => message.type === "resize")).toBe(false);
    expect(bob.conn.messages.some((message) => message.type === "error")).toBe(false);
  });
});

function lastMessageOfType<T extends ServerMessage["type"]>(
  messages: ServerMessage[],
  type: T,
): Extract<ServerMessage, { type: T }> {
  const message = [...messages]
    .reverse()
    .find((candidate): candidate is Extract<ServerMessage, { type: T }> => candidate.type === type);
  if (!message) throw new Error(`${type} 메시지가 없다`);
  return message;
}

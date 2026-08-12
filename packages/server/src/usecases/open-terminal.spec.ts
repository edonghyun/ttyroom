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

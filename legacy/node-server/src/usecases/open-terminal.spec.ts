import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RecordingRoomRepository } from "../test/recording-room-repository.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("openTerminal — 역할: 터미널 생성 요청의 중개", () => {
  it("open-terminal-request는 host에게 open-terminal 명령을 전달한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");

    await alice.send({ type: "open-terminal-request", hostId: host.hostId });

    expect(host.conn.lastMessageOfType("open-terminal")).toMatchObject({
      cols: 80,
      rows: 24,
    });
  });

  it("저장 실패 시 terminal 생성을 되돌리고 host에게 명령하지 않는다", async () => {
    const repository = new RecordingRoomRepository();
    const ctx = new RoomTestContext({ repository });
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    host.conn.clear();
    repository.failSavesWith(new Error("save failed"));

    await expect(
      alice.send({ type: "open-terminal-request", hostId: host.hostId }),
    ).rejects.toThrow("save failed");

    expect(host.conn.messagesOfType("open-terminal")).toEqual([]);
    expect(ctx.snapshot(room)?.terminals).toEqual([]);
  });

  it("host가 terminal-opened를 확인하면 참여자 전원에게 terminal-opened 이벤트가 브로드캐스트된다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;

    await host.send({ type: "terminal-opened", terminalId });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: {
        kind: "terminal-opened",
        terminal: { terminalId, hostId: host.hostId, status: "open" },
      },
    });
  });

  it("같은 terminal-opened 확인이 재도착해도 열린 이벤트를 중복 브로드캐스트하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;

    await host.send({ type: "terminal-opened", terminalId });
    await host.send({ type: "terminal-opened", terminalId });

    expect(alice.conn.roomEventsOfKind("terminal-opened")).toHaveLength(1);
  });

  it("오프라인 host에 대한 요청은 요청자에게만 error(bad-message)를 보낸다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    const bob = await ctx.connectParticipant(room, "bob");
    await host.disconnect();

    await alice.send({ type: "open-terminal-request", hostId: host.hostId });

    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
    expect(bob.conn.messagesOfType("error")).toEqual([]);
  });

  it("host의 terminal-closed는 종료 상태를 반영하고 참여자에게 브로드캐스트한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;

    await host.send({ type: "terminal-closed", terminalId, exitCode: 7 });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "terminal-closed", terminalId, exitCode: 7 },
    });
    const observer = await ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { terminals: [{ terminalId, status: "exited", exitCode: 7 }] },
    });
  });

  it("participant close 요청은 owning host로 전달되고 종료 이벤트는 host 확인 뒤에만 발생한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;
    await host.send({ type: "terminal-opened", terminalId });
    alice.conn.clear();

    await alice.send({ type: "close-terminal-request", terminalId });

    expect(host.conn.lastMessageOfType("close-terminal")).toEqual({
      type: "close-terminal",
      terminalId,
    });
    expect(alice.conn.roomEventsOfKind("terminal-closed")).toEqual([]);

    await host.send({ type: "terminal-closed", terminalId, exitCode: 0 });
    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "terminal-closed", terminalId, exitCode: 0 },
    });
  });

  it("participant close 요청은 terminal 상태와 owning host 연결을 typed 사유로 검증한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");

    await alice.send({ type: "close-terminal-request", terminalId: 999 });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "close",
      terminalId: 999,
      reason: "terminal-not-found",
    });

    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;
    await host.send({ type: "terminal-closed", terminalId, exitCode: 0 });
    await alice.send({ type: "close-terminal-request", terminalId });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "close",
      terminalId,
      reason: "terminal-not-open",
    });

    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const offlineTerminal = host.conn.lastMessageOfType("open-terminal").terminalId;
    await host.disconnect();
    await alice.send({ type: "close-terminal-request", terminalId: offlineTerminal });
    expectMessageToMatch(alice.conn.messages, "terminal-request-rejected", {
      request: "close",
      terminalId: offlineTerminal,
      reason: "host-offline",
    });
  });

  it("같은 terminal-closed가 재도착해도 종료 이벤트를 중복 브로드캐스트하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;

    await host.send({ type: "terminal-closed", terminalId, exitCode: 0 });
    await host.send({ type: "terminal-closed", terminalId, exitCode: 0 });

    expect(alice.conn.roomEventsOfKind("terminal-closed")).toHaveLength(1);
  });

  it("이미 종료된 터미널의 늦은 terminal-opened는 열린 이벤트를 만들지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;

    await host.send({ type: "terminal-closed", terminalId, exitCode: 1 });
    await host.send({ type: "terminal-opened", terminalId });

    expect(alice.conn.roomEventsOfKind("terminal-opened")).toEqual([]);
  });

  it("host의 terminal-meta는 메타데이터를 반영하고 참여자에게 브로드캐스트한다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;
    const meta = { cwd: "/tmp", gitBranch: "main", fgProcess: "zsh" };

    await host.send({ type: "terminal-meta", terminalId, meta });

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "terminal-meta", terminalId, meta },
    });
    const observer = await ctx.connectParticipant(room, "observer");
    expectMessageToMatch(observer.conn.messages, "welcome", {
      snapshot: { terminals: [{ terminalId, meta }] },
    });
  });

  it("동일한 terminal-meta 재전송은 이벤트를 중복 브로드캐스트하지 않는다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;
    const meta = { cwd: "/tmp", gitBranch: "main", fgProcess: "zsh" };

    await host.send({ type: "terminal-meta", terminalId, meta });
    await host.send({ type: "terminal-meta", terminalId, meta });

    expect(alice.conn.roomEventsOfKind("terminal-meta")).toHaveLength(1);
  });

  it("participant의 resize-request는 터미널 host에게 resize 명령으로 전달된다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    await alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = host.conn.lastMessageOfType("open-terminal").terminalId;

    await alice.send({ type: "resize-request", terminalId, cols: 132, rows: 43 });

    expect(host.conn.lastMessageOfType("resize")).toMatchObject({
      terminalId,
      cols: 132,
      rows: 43,
    });
  });

  it("존재하지 않는 터미널 resize는 host에 전달하지 않고 요청자에게만 error를 보낸다", async () => {
    const ctx = new RoomTestContext();
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "h");
    const alice = await ctx.connectParticipant(room, "alice");
    const bob = await ctx.connectParticipant(room, "bob");

    await alice.send({ type: "resize-request", terminalId: 999, cols: 80, rows: 24 });

    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
    expect(host.conn.messagesOfType("resize")).toEqual([]);
    expect(bob.conn.messagesOfType("error")).toEqual([]);
  });
});

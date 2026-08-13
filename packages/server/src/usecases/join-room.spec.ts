import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@ttyroom/protocol";
import { RoomTestContext } from "../test/room-test-context.js";
import { expectMessageToMatch } from "../test/matchers.js";

describe("joinRoom — 역할: hello 검증과 Room 입장", () => {
  it("유효한 hello에 현재 Room 스냅샷이 담긴 welcome으로 응답한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");
    expectMessageToMatch(alice.conn.messages, "welcome", {
      selfClientId: alice.clientId,
      snapshot: { roomId: room.roomId, participants: [{ name: "alice" }] },
    });
  });

  it("입장하면 기존 참여자 전원에게 participant-joined가 브로드캐스트된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");
    ctx.connectParticipant(room, "bob");
    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "participant-joined", participant: { name: "bob" } },
    });
  });

  it("틀린 토큰의 hello는 error(invalid-token) 후 연결이 닫힌다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant({ ...room, token: "wrong" }, "alice");
    expectMessageToMatch(alice.conn.messages, "error", { code: "invalid-token" });
    expect(alice.conn.closed).toBe(true);
  });

  it("없는 Room의 hello는 error(room-not-found)로 거부된다", () => {
    const ctx = new RoomTestContext();
    const alice = ctx.connectParticipant({ roomId: "ghost", token: "t" }, "alice");
    expectMessageToMatch(alice.conn.messages, "error", { code: "room-not-found" });
  });

  it("프로토콜 버전 불일치는 error(unsupported-protocol-version)로 거부된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    // 등록된 연결의 재hello는 bad-message로 먼저 걸리므로(승인 계약),
    // 버전 검사는 미등록 생 연결에서 검증한다 — connectParticipant는 PROTOCOL_VERSION을 쓰기 때문
    const conn = ctx.rawConnection();
    ctx.core.handleMessage(
      conn,
      JSON.stringify({
        type: "hello",
        protocolVersion: 999,
        roomId: room.roomId,
        token: room.token,
        clientId: "x",
        name: "x",
        role: "participant",
      }),
    );
    expectMessageToMatch(conn.messages, "error", { code: "unsupported-protocol-version" });
  });

  it("구형 v1 hello는 현재 server에서 unsupported로 명확히 거부되고 연결이 닫힌다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const conn = ctx.rawConnection();

    ctx.core.handleMessage(
      conn,
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        roomId: room.roomId,
        token: room.token,
        clientId: "legacy-client",
        name: "legacy",
        role: "participant",
      }),
    );

    expectMessageToMatch(conn.messages, "error", {
      code: "unsupported-protocol-version",
      message: `server=${PROTOCOL_VERSION}`,
    });
    expect(conn.closed).toBe(true);
  });

  it("등록된 연결의 재hello는 error(bad-message)이고 연결과 기존 세션은 유지된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({
      type: "hello",
      protocolVersion: 1,
      roomId: room.roomId,
      token: room.token,
      clientId: alice.clientId,
      name: "alice-again",
      role: "participant",
    });

    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
    expect(alice.conn.messages.filter((m) => m.type === "welcome")).toHaveLength(1);
    expect(alice.conn.closed).toBe(false);

    // 기존 세션이 유효하게 유지 — 이후 브로드캐스트를 계속 받는다
    ctx.connectParticipant(room, "bob");
    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "participant-joined", participant: { name: "bob" } },
    });
  });

  it("같은 clientId의 재접속은 이전 세션을 대체한다 — 이전 연결은 닫히고 브로드캐스트에서 빠진다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const stale = ctx.connectParticipant(room, "alice", "c-alice");
    const fresh = ctx.connectParticipant(room, "alice", "c-alice");
    const staleEventCount = stale.conn.messages.filter((m) => m.type === "room-event").length;

    ctx.connectParticipant(room, "bob");

    expect(stale.conn.closed).toBe(true);
    expect(stale.conn.messages.filter((m) => m.type === "room-event")).toHaveLength(
      staleEventCount,
    );
    expectMessageToMatch(fresh.conn.messages, "room-event", {
      event: { kind: "participant-joined", participant: { name: "bob" } },
    });
  });

  it("이미 참여자인 clientId의 재접속은 participant-joined를 다시 브로드캐스트하지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const bob = ctx.connectParticipant(room, "bob");
    ctx.connectParticipant(room, "alice", "c-alice");
    const joinedCount = () =>
      bob.conn.messages.filter(
        (m) =>
          m.type === "room-event" &&
          m.event.kind === "participant-joined" &&
          m.event.participant.clientId === "c-alice",
      ).length;
    expect(joinedCount()).toBe(1);

    // 다른 참여자는 left를 본 적 없으므로 joined도 다시 보면 안 된다 (T2.9 조용한 복원의 전제)
    ctx.connectParticipant(room, "alice", "c-alice");
    expect(joinedCount()).toBe(1);
  });

  it("틀린 토큰의 hello는 기존 세션을 supersede하지 못한다 — supersede는 auth 성공 이후에만", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice", "c-alice");
    const attacker = ctx.connectParticipant({ ...room, token: "wrong" }, "alice", "c-alice");

    expect(attacker.conn.closed).toBe(true);
    expect(alice.conn.closed).toBe(false);
    ctx.connectParticipant(room, "bob");
    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "participant-joined", participant: { name: "bob" } },
    });
  });

  it("clientId는 Room 스코프다 — 같은 clientId의 다른 Room 조인은 supersede가 아니다", () => {
    const ctx = new RoomTestContext();
    const room1 = ctx.createRoom();
    const room2 = ctx.createRoom();
    const inRoom1 = ctx.connectParticipant(room1, "alice", "c-alice");
    const inRoom2 = ctx.connectParticipant(room2, "alice", "c-alice");

    expect(inRoom1.conn.closed).toBe(false);
    expect(inRoom2.conn.closed).toBe(false);

    ctx.connectParticipant(room1, "bob");
    expectMessageToMatch(inRoom1.conn.messages, "room-event", {
      event: { kind: "participant-joined", participant: { name: "bob" } },
    });
    expect(inRoom2.conn.messages.filter((m) => m.type === "room-event")).toHaveLength(0);
  });

  it("supersede된 이전 연결의 close 통지는 새 세션을 건드리지 않는다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const stale = ctx.connectParticipant(room, "alice", "c-alice");
    const fresh = ctx.connectParticipant(room, "alice", "c-alice");

    // 전송 계약상 닫힌 연결의 close 통지는 반드시 한 번 도착한다 — supersede 후 지연 도착 재현
    ctx.core.handleClose(stale.conn);

    ctx.connectParticipant(room, "bob");
    expectMessageToMatch(fresh.conn.messages, "room-event", {
      event: { kind: "participant-joined", participant: { name: "bob" } },
    });
  });

  it("hello 이전의 다른 메시지는 error(bad-message)다", () => {
    const ctx = new RoomTestContext();
    const conn = ctx.rawConnection();
    ctx.core.handleMessage(conn, JSON.stringify({ type: "acquire-lease", terminalId: 1 }));
    expectMessageToMatch(conn.messages, "error", { code: "bad-message" });
  });

  it("JSON이 아닌 프레임은 error(bad-message)이고 연결은 유지된다", () => {
    const ctx = new RoomTestContext();
    const conn = ctx.rawConnection();
    ctx.core.handleMessage(conn, "not json {{{");
    expectMessageToMatch(conn.messages, "error", { code: "bad-message" });
    expect(conn.closed).toBe(false);
  });

  it("hello 전에 끊긴 미등록 연결의 close 통지는 안전하다", () => {
    const ctx = new RoomTestContext();
    const conn = ctx.rawConnection();
    expect(() => ctx.core.handleClose(conn)).not.toThrow();
  });
});

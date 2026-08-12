import { describe, expect, it } from "vitest";
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
    const alice = ctx.connectParticipant(room, "alice");
    alice.conn.messages.length = 0;
    // RoomTestContext.connectParticipant는 PROTOCOL_VERSION을 쓰므로, 버전만 다른 hello를 직접 주입
    ctx.core.handleMessage(
      alice.conn,
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
    expectMessageToMatch(alice.conn.messages, "error", { code: "unsupported-protocol-version" });
  });

  it("hello 이전의 다른 메시지는 error(bad-message)다", () => {
    const ctx = new RoomTestContext();
    const conn = ctx.rawConnection();
    ctx.core.handleMessage(conn, JSON.stringify({ type: "acquire-lease", terminalId: 1 }));
    expectMessageToMatch(conn.messages, "error", { code: "bad-message" });
  });
});

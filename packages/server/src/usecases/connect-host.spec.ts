import { describe, expect, it } from "vitest";
import { expectMessageToMatch } from "../test/matchers.js";
import { RoomTestContext } from "../test/room-test-context.js";

describe("connectHost — 역할: Agent hello 처리와 Host 등록", () => {
  it("host hello로 Room에 host가 등록되고 참여자에게 host-connected가 브로드캐스트된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");

    ctx.connectHost(room, "동현-Mac");

    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "host-connected", host: { name: "동현-Mac", online: true } },
    });
  });

  it("같은 hostId 재접속은 host를 online으로 복귀시킨다 (중복 등록 없음)", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "동현-Mac");
    host.disconnect();

    const again = ctx.connectHost(room, "동현-Mac", host.hostId);

    expectMessageToMatch(again.conn.messages, "welcome", {
      snapshot: { hosts: [{ hostId: host.hostId, online: true }] },
    });
  });

  it("같은 hostId의 새 연결은 이전 세션을 대체해 이후 명령이 새 연결로만 간다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const stale = ctx.connectHost(room, "동현-Mac", "host-1");
    const fresh = ctx.connectHost(room, "동현-Mac", "host-1");
    const alice = ctx.connectParticipant(room, "alice");

    alice.send({ type: "open-terminal-request", hostId: "host-1" });

    expect(stale.conn.closed).toBe(true);
    expect(stale.conn.messages.some((message) => message.type === "open-terminal")).toBe(false);
    expect(fresh.conn.messages.some((message) => message.type === "open-terminal")).toBe(true);
  });
});

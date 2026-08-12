import { describe, expect, it } from "vitest";
import { RoomRegistry } from "./room-registry.js";

describe("RoomRegistry — 역할: 라이브 Room 인스턴스의 보관소", () => {
  it("create한 Room을 get으로 돌려준다", () => {
    const registry = new RoomRegistry();
    const room = registry.create({ roomId: "r1", token: "tok" });
    expect(registry.get("r1")).toBe(room);
    expect(room.roomId).toBe("r1");
  });

  it("중복 roomId create는 throw한다 (프로그래머 오류)", () => {
    const registry = new RoomRegistry();
    registry.create({ roomId: "r1", token: "tok" });
    expect(() => registry.create({ roomId: "r1", token: "tok2" })).toThrow();
  });

  it("remove 후 get은 undefined다", () => {
    const registry = new RoomRegistry();
    registry.create({ roomId: "r1", token: "tok" });
    registry.remove("r1");
    expect(registry.get("r1")).toBeUndefined();
  });
});

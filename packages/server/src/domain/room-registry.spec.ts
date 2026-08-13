import { describe, expect, it } from "vitest";
import { Room, type StoredRoomRecord } from "./room.js";
import type { RoomRepository } from "../ports/room-repository.js";
import { RoomRegistry } from "./room-registry.js";

describe("RoomRegistry — 역할: 라이브 Room 인스턴스의 보관소", () => {
  it("repository 레코드를 부팅 시 복원하고 durable 변경을 명시적으로 저장한다", () => {
    const repository = new FakeRoomRepository([
      new Room({ roomId: "restored", token: "tok", name: "Restored Room" }).record(),
    ]);
    const registry = RoomRegistry.restore(repository);
    const restored = registry.get("restored");
    if (!restored) throw new Error("Room이 복원되지 않았다");
    restored.connectHost("host-1", "Mac");

    registry.save(restored);

    expect(repository.saved.at(-1)).toMatchObject({
      roomId: "restored",
      hosts: [{ hostId: "host-1" }],
    });
  });

  it("repository를 가진 registry는 create와 remove를 즉시 내구화한다", () => {
    const repository = new FakeRoomRepository();
    const registry = RoomRegistry.restore(repository);

    registry.create({ roomId: "r1", token: "tok" });
    registry.remove("r1");

    expect(repository.saved).toMatchObject([{ roomId: "r1" }]);
    expect(repository.deleted).toEqual(["r1"]);
  });

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

  it("없는 roomId의 remove는 조용한 no-op이다 (소멸 경로 중복 도착 안전)", () => {
    const registry = new RoomRegistry();
    expect(() => registry.remove("nope")).not.toThrow();
  });
});

class FakeRoomRepository implements RoomRepository {
  readonly saved: StoredRoomRecord[] = [];
  readonly deleted: string[] = [];

  constructor(private readonly records: StoredRoomRecord[] = []) {}

  loadAll(): StoredRoomRecord[] {
    return structuredClone(this.records);
  }

  save(record: StoredRoomRecord): void {
    this.saved.push(structuredClone(record));
  }

  delete(roomId: string): void {
    this.deleted.push(roomId);
  }

  close(): void {}
}

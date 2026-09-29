import { describe, expect, it } from "vitest";
import { RecordingRoomRepository } from "../test/recording-room-repository.js";
import { Room } from "../domain/room.js";
import { RecordingTelemetry } from "../test/recording-telemetry.js";
import { OperationalDiagnostics } from "./operational-diagnostics.js";
import { RoomRegistry } from "./room-registry.js";

describe("RoomRegistry — 역할: 라이브 Room 인스턴스의 보관소", () => {
  it("repository 작업의 종류·roomId·결과·지연을 기록한다", async () => {
    const repository = new RecordingRoomRepository();
    const telemetry = new RecordingTelemetry();
    let now = 0;
    const diagnostics = new OperationalDiagnostics(telemetry, () => (now += 5));
    const registry = await RoomRegistry.restore(repository, diagnostics);

    await registry.create({ roomId: "r1", token: "tok" });

    expect(telemetry.ofType("persistence").slice(0, 2)).toEqual([
      {
        type: "persistence",
        operation: "load-all",
        outcome: "completed",
        durationMs: 5,
      },
      {
        type: "persistence",
        operation: "save",
        roomId: "r1",
        outcome: "completed",
        durationMs: 5,
      },
    ]);
  });

  it("repository 레코드를 부팅 시 복원하고 durable 변경을 명시적으로 저장한다", async () => {
    const repository = new RecordingRoomRepository([
      new Room({ roomId: "restored", token: "tok", name: "Restored Room" }).record(),
    ]);
    const registry = await RoomRegistry.restore(repository);
    const restored = registry.get("restored");
    if (!restored) throw new Error("Room이 복원되지 않았다");
    await registry.change(restored, (draft) => draft.connectHost("host-1", "Mac"));

    expect(repository.savedRecords.at(-1)).toMatchObject({
      roomId: "restored",
      hosts: [{ hostId: "host-1" }],
    });
  });

  it("live 상태 변경도 같은 직렬화 경계를 통과하지만 repository에는 저장하지 않는다", async () => {
    const repository = new RecordingRoomRepository();
    const registry = await RoomRegistry.restore(repository);
    const room = await registry.create({ roomId: "r1", token: "tok" });
    const savedAfterCreate = repository.savedRecords.length;

    await registry.change(room, (draft) => draft.addParticipant("p1", "Kim"));

    expect(room.snapshot().participants).toEqual([
      { clientId: "p1", name: "Kim", focusedTerminalId: null },
    ]);
    expect(repository.savedRecords).toHaveLength(savedAfterCreate);
  });

  it("repository를 가진 registry는 create와 remove를 즉시 내구화한다", async () => {
    const repository = new RecordingRoomRepository();
    const registry = await RoomRegistry.restore(repository);

    await registry.create({ roomId: "r1", token: "tok" });
    await registry.remove("r1");

    expect(repository.savedRecords).toMatchObject([{ roomId: "r1" }]);
    expect(repository.deletedRoomIds).toEqual(["r1"]);
  });

  it("create한 Room을 get으로 돌려준다", async () => {
    const registry = new RoomRegistry();
    const room = await registry.create({ roomId: "r1", token: "tok" });
    expect(registry.get("r1")).toBe(room);
    expect(room.roomId).toBe("r1");
  });

  it("중복 roomId create는 throw한다 (프로그래머 오류)", async () => {
    const registry = new RoomRegistry();
    await registry.create({ roomId: "r1", token: "tok" });
    await expect(registry.create({ roomId: "r1", token: "tok2" })).rejects.toThrow();
  });

  it("remove 후 get은 undefined다", async () => {
    const registry = new RoomRegistry();
    await registry.create({ roomId: "r1", token: "tok" });
    await registry.remove("r1");
    expect(registry.get("r1")).toBeUndefined();
  });

  it("없는 roomId의 remove는 조용한 no-op이다 (소멸 경로 중복 도착 안전)", async () => {
    const registry = new RoomRegistry();
    await expect(registry.remove("nope")).resolves.toBeUndefined();
  });

  it("save 실패 시 변경 전 Room 전체 상태로 되돌린다", async () => {
    const repository = new RecordingRoomRepository();
    const registry = await RoomRegistry.restore(repository);
    const room = await registry.create({ roomId: "r1", token: "tok" });
    room.addParticipant("p1", "Kim");
    const before = room.snapshot();
    repository.failSavesWith(new Error("save failed"));

    await expect(
      registry.change(room, (draft) => {
        draft.connectHost("h1", "Mac");
        draft.openTerminal("h1");
        draft.acquireLease("p1", 1);
      }),
    ).rejects.toThrow("save failed");

    expect(room.snapshot()).toEqual(before);
    expect(room.record().nextTerminalId).toBe(1);
  });

  it("save 대기 중 변경을 노출하지 않고 실패해도 그 사이의 live 상태를 보존한다", async () => {
    const repository = new RecordingRoomRepository();
    const registry = await RoomRegistry.restore(repository);
    const room = await registry.create({ roomId: "r1", token: "tok" });
    const save = repository.deferNextSave();
    repository.failSavesWith(new Error("save failed"));

    const changing = registry.change(room, (draft) => draft.connectHost("h1", "Mac"));
    await save.started;
    room.addParticipant("p1", "Kim");
    expect(room.snapshot()).toMatchObject({ hosts: [], participants: [{ clientId: "p1" }] });

    save.release();
    await expect(changing).rejects.toThrow("save failed");
    expect(room.snapshot()).toMatchObject({ hosts: [], participants: [{ clientId: "p1" }] });
  });

  it("delete 실패 시 Room을 registry에서 제거하지 않는다", async () => {
    const repository = new RecordingRoomRepository();
    const registry = await RoomRegistry.restore(repository);
    const room = await registry.create({ roomId: "r1", token: "tok" });
    repository.failDeletesWith(new Error("delete failed"));

    await expect(registry.remove("r1")).rejects.toThrow("delete failed");

    expect(registry.get("r1")).toBe(room);
  });
});

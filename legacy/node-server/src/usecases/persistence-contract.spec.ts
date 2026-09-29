import { describe, expect, it } from "vitest";
import { RecordingRoomRepository } from "../test/recording-room-repository.js";
import { RoomTestContext } from "../test/room-test-context.js";
import { RoomRegistry } from "./room-registry.js";

async function editableRoomFixture() {
  const repository = new RecordingRoomRepository();
  const ctx = new RoomTestContext({ repository });
  try {
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "host");
    const alice = await ctx.connectParticipant(room, "alice");
    const bob = await ctx.connectParticipant(room, "bob");
    const terminalId = await ctx.openTerminal(alice, host);
    return {
      repository,
      ctx,
      room,
      host,
      alice,
      bob,
      terminalId,
      [Symbol.asyncDispose]: () => ctx.close(),
    };
  } catch (error) {
    await ctx.close();
    throw error;
  }
}

function registryFixture() {
  const repository = new RecordingRoomRepository();
  const registry = new RoomRegistry(repository);
  return { repository, registry, [Symbol.asyncDispose]: () => registry.close() };
}

describe("영속 저장 순서 — Spring 이식 시 유지할 Node 계약", () => {
  it.each(["success", "failure"])(
    "%s: save 완료 전에는 상태·알림을 노출하지 않는다",
    async (outcome) => {
      await using f = await editableRoomFixture();
      const before = f.ctx.snapshot(f.room);
      const failure = new Error("disk unavailable");
      if (outcome === "failure") f.repository.failSavesWith(failure);
      const save = f.repository.deferNextSave();

      const changing = f.alice
        .send({ type: "rename-terminal", terminalId: f.terminalId, title: "saved-title" })
        .then(
          () => undefined,
          (error) => error,
        );
      await save.started;
      const whileSaving = f.ctx.snapshot(f.room);
      const notificationsWhileSaving = [...f.bob.conn.roomEventsOfKind("terminal-renamed")];
      save.release();
      const error = await changing;
      const after = f.ctx.snapshot(f.room);
      const notificationsAfter = f.bob.conn.roomEventsOfKind("terminal-renamed");

      expect(whileSaving).toEqual(before);
      expect(notificationsWhileSaving).toEqual([]);
      if (outcome === "failure") {
        expect(error).toBe(failure);
        expect(after).toEqual(before);
        expect(notificationsAfter).toEqual([]);
      } else {
        expect(error).toBeUndefined();
        expect(after?.terminals[0]?.title).toBe("saved-title");
        expect(notificationsAfter).toHaveLength(1);
        expect(f.repository.savedRecords.at(-1)?.terminals[0]?.view.title).toBe("saved-title");
      }
    },
  );

  it("live-only 상태·동일 값·cursor·출력은 저장을 추가하지 않는다", async () => {
    await using f = await editableRoomFixture();
    const saves = f.repository.savedRecords.length;

    await f.alice.send({ type: "focus-terminal", terminalId: f.terminalId });
    await f.alice.send({ type: "acquire-lease", terminalId: f.terminalId });
    await f.host.send({ type: "host-input-state", remoteInputAllowed: false });
    await f.alice.send({ type: "move-cursor", position: { x: 1, y: 2 } });
    await f.alice.send({
      type: "rename-terminal",
      terminalId: f.terminalId,
      title: `term-${f.terminalId}`,
    });
    f.host.sendOutput(f.terminalId, 1, "live-output");

    expect(f.repository.savedRecords).toHaveLength(saves);
    expect(f.bob.conn.dataFrames.at(-1)).toMatchObject({
      kind: "output",
      terminalId: f.terminalId,
    });
    expect(f.bob.conn.messagesOfType("participant-cursor")).toHaveLength(1);
    expect(f.ctx.snapshot(f.room)?.participants).toContainEqual(
      expect.objectContaining({ clientId: f.alice.clientId, focusedTerminalId: f.terminalId }),
    );
    expect(f.ctx.snapshot(f.room)?.leases).toHaveLength(1);
  });

  it("방 생성 저장이 실패하면 대기 중과 실패 후 모두 방을 노출하지 않는다", async () => {
    await using f = registryFixture();
    const failure = new Error("create save failed");
    f.repository.failSavesWith(failure);
    const save = f.repository.deferNextSave();

    const creating = f.registry
      .create({ roomId: "new-room", token: "test-token" })
      .catch((error) => error);
    await save.started;
    const whileSaving = f.registry.get("new-room");
    save.release();
    const error = await creating;
    const afterFailure = f.registry.get("new-room");

    expect(whileSaving).toBeUndefined();
    expect(error).toBe(failure);
    expect(afterFailure).toBeUndefined();
    expect(f.repository.savedRecords).toEqual([]);
  });

  it("실패한 저장 뒤 같은 방의 live 명령은 계속되고 다른 방은 저장을 기다리지 않는다", async () => {
    await using f = registryFixture();
    const { repository, registry } = f;
    const roomA = await registry.create({ roomId: "A", token: "test-a" });
    const roomB = await registry.create({ roomId: "B", token: "test-b" });
    const save = repository.deferNextSave();
    const failure = new Error("save failed");
    repository.failSavesWith(failure);
    const completed: string[] = [];

    const changing = registry
      .change(roomA, (draft) => draft.connectHost("host", "host"))
      .catch((error) => error);
    await save.started;
    const queued = registry.change(roomA, (draft) => {
      draft.addParticipant("alice", "alice");
      completed.push("A");
    });
    await registry.change(roomB, (draft) => {
      draft.addParticipant("bob", "bob");
      completed.push("B");
    });
    const whileSaving = [...completed];
    save.release();
    const error = await changing;
    await queued;

    expect(whileSaving).toEqual(["B"]);
    expect(completed).toEqual(["B", "A"]);
    expect(error).toBe(failure);
    expect(roomA.snapshot()).toMatchObject({ hosts: [], participants: [{ clientId: "alice" }] });
  });
});

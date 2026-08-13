import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Room } from "../../domain/room.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SqliteRoomRepository — 서버 재시작 내구 상태", () => {
  it("새 연결에서 저장한 Room을 같은 레코드로 다시 읽는다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ttyroom-repository-"));
    cleanups.push(directory);
    const path = join(directory, "state.sqlite");
    const room = new Room({ roomId: "room-1", token: "secret", name: "Payment Debug" });
    room.connectHost("host-1", "Donghyeon-Mac");
    const terminal = room.openTerminal("host-1");
    room.confirmTerminalOpened(terminal.terminalId, "runtime-1");
    room.renameTerminal(terminal.terminalId, "API logs");

    const first = new SqliteRoomRepository(path);
    first.save(room.record());
    first.close();

    const second = new SqliteRoomRepository(path);
    expect(second.loadAll()).toEqual([room.record()]);
    second.close();
  });

  it("같은 roomId 저장은 원자적으로 최신 레코드로 교체한다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ttyroom-repository-"));
    cleanups.push(directory);
    const repository = new SqliteRoomRepository(join(directory, "state.sqlite"));
    const room = new Room({ roomId: "room-1", token: "secret" });
    repository.save(room.record());
    room.connectHost("host-1", "Mac");

    repository.save(room.record());

    expect(repository.loadAll()).toMatchObject([{ hosts: [{ hostId: "host-1" }] }]);
    repository.close();
  });
});

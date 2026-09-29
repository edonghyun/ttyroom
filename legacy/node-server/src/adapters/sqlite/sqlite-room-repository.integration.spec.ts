import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { Room } from "../../domain/room.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("SqliteRoomRepository — 서버 재시작 내구 상태", () => {
  it("새 연결에서 저장한 Room을 같은 레코드로 다시 읽는다", async () => {
    const context = await createRepositoryContext();
    const room = createRoomWithHostAndTerminal();
    await context.repository.save(room.record());

    await context.reopen();

    expect(await context.repository.loadAll()).toEqual([room.record()]);
  });

  it("같은 roomId 저장은 원자적으로 최신 레코드로 교체한다", async () => {
    const context = await createRepositoryContext();
    const room = new Room({ roomId: "room-1", token: "secret" });
    await context.repository.save(room.record());
    room.connectHost("host-1", "Mac");

    await context.repository.save(room.record());

    expect(await context.repository.loadAll()).toMatchObject([{ hosts: [{ hostId: "host-1" }] }]);
  });

  it("close 전에 접수한 저장은 완료하고 close 시작 뒤 새 요청은 거부한다", async () => {
    const context = await createRepositoryContext();
    const room = createRoomWithHostAndTerminal();
    const save = context.repository.save(room.record());

    const close = context.repository.close();

    await expect(context.repository.loadAll()).rejects.toThrow(/닫히는 중이거나 닫힌/);
    await Promise.all([save, close]);
    await context.reopen();
    expect(await context.repository.loadAll()).toEqual([room.record()]);
  });

  it("worker가 close 응답 전에 종료되면 close를 즉시 실패시킨다", async () => {
    const repository = new SqliteRoomRepository("unused.sqlite", {
      createWorker: () =>
        new Worker(
          `
            const { parentPort } = require("node:worker_threads");
            parentPort.on("message", (message) => {
              if (message.operation === "close") process.exit(23);
            });
          `,
          { eval: true },
        ),
    });
    cleanups.push(async () => {
      await repository.close().catch(() => undefined);
    });

    await expect(repository.close()).rejects.toThrow("SQLite worker 종료 코드: 23");
  });
});

async function createRepositoryContext(): Promise<{
  readonly repository: SqliteRoomRepository;
  reopen(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ttyroom-repository-"));
  const path = join(directory, "state.sqlite");
  let repository = new SqliteRoomRepository(path);

  cleanups.push(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    get repository() {
      return repository;
    },
    async reopen() {
      await repository.close();
      repository = new SqliteRoomRepository(path);
    },
  };
}

function createRoomWithHostAndTerminal(): Room {
  const room = new Room({ roomId: "room-1", token: "secret", name: "Payment Debug" });
  room.connectHost("host-1", "Donghyeon-Mac");
  const terminal = room.openTerminal("host-1");
  room.confirmTerminalOpened(terminal.terminalId, "runtime-1");
  room.renameTerminal(terminal.terminalId, "API logs");
  return room;
}

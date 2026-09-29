import { Room } from "../domain/room.js";
import type { RoomRepository } from "../ports/room-repository.js";
import { OperationalDiagnostics } from "./operational-diagnostics.js";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly pending = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    private readonly repository: RoomRepository | null = null,
    private readonly diagnostics = new OperationalDiagnostics(),
  ) {}

  static async restore(
    repository: RoomRepository,
    diagnostics = new OperationalDiagnostics(),
  ): Promise<RoomRegistry> {
    const registry = new RoomRegistry(repository, diagnostics);
    try {
      const records = await diagnostics.persistence({ operation: "load-all" }, () =>
        repository.loadAll(),
      );
      for (const record of records) {
        const room = Room.restore(record);
        if (registry.rooms.has(room.roomId)) {
          throw new Error(`중복 저장된 roomId: ${room.roomId}`);
        }
        registry.rooms.set(room.roomId, room);
      }
      return registry;
    } catch (error) {
      await diagnostics.persistence({ operation: "close" }, () => repository.close());
      throw error;
    }
  }

  async create(options: { roomId: string; token: string; name?: string }): Promise<Room> {
    return this.enqueue(options.roomId, async () => {
      this.assertOpen();
      if (this.rooms.has(options.roomId)) {
        throw new Error(`이미 존재하는 roomId: ${options.roomId}`);
      }

      const room = new Room(options);
      const repository = this.repository;
      if (repository) {
        await this.diagnostics.persistence({ operation: "save", roomId: room.roomId }, () =>
          repository.save(room.record()),
        );
      }
      this.rooms.set(options.roomId, room);
      return room;
    });
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  async remove(roomId: string): Promise<void> {
    await this.enqueue(roomId, async () => {
      this.assertOpen();
      if (!this.rooms.has(roomId)) return;
      const repository = this.repository;
      if (repository) {
        await this.diagnostics.persistence({ operation: "delete", roomId }, () =>
          repository.delete(roomId),
        );
      }
      this.rooms.delete(roomId);
    });
  }

  // 모든 Room control mutation을 roomId별로 직렬화한다. Durable record가 달라진 경우에만
  // 먼저 저장하고 live instance에 commit하므로 caller는 저장 여부나 순서를 알 필요가 없다.
  change<T>(room: Room, change: (draft: Room) => T): Promise<T> {
    return this.enqueue(room.roomId, async () => {
      this.assertOpen();
      if (this.rooms.get(room.roomId) !== room) {
        throw new Error(`registry가 소유하지 않은 Room은 변경할 수 없다: ${room.roomId}`);
      }
      const staged = room.stageChange(change);
      const recordToSave = staged.recordToSave;
      const repository = this.repository;
      if (recordToSave && repository) {
        await this.diagnostics.persistence({ operation: "save", roomId: room.roomId }, () =>
          repository.save(recordToSave),
        );
      }
      staged.commit();
      return staged.result;
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.pending.values());
    const repository = this.repository;
    if (repository) {
      await this.diagnostics.persistence({ operation: "close" }, () => repository.close());
    }
  }

  private enqueue<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(roomId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(roomId, settled);
    void settled.then(() => {
      if (this.pending.get(roomId) === settled) this.pending.delete(roomId);
    });
    return result;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("닫히는 중인 Room registry는 변경할 수 없다");
  }
}

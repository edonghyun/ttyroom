import { Room } from "./room.js";
import type { RoomRepository } from "../ports/room-repository.js";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly pending = new Map<string, Promise<void>>();
  private closing = false;

  constructor(private readonly repository: RoomRepository | null = null) {}

  static async restore(repository: RoomRepository): Promise<RoomRegistry> {
    const registry = new RoomRegistry(repository);
    try {
      for (const record of await repository.loadAll()) {
        const room = Room.restore(record);
        if (registry.rooms.has(room.roomId)) {
          throw new Error(`중복 저장된 roomId: ${room.roomId}`);
        }
        registry.rooms.set(room.roomId, room);
      }
      return registry;
    } catch (error) {
      await repository.close();
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
      await this.repository?.save(room.record());
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
      await this.repository?.delete(roomId);
      this.rooms.delete(roomId);
    });
  }

  change<T>(room: Room, change: (draft: Room) => T): Promise<T> {
    return this.enqueue(room.roomId, async () => {
      this.assertOpen();
      if (this.rooms.get(room.roomId) !== room) {
        throw new Error(`registry가 소유하지 않은 Room은 변경할 수 없다: ${room.roomId}`);
      }
      const staged = room.stageDurableChange(change);
      await this.repository?.save(staged.record);
      staged.commit();
      return staged.result;
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.pending.values());
    await this.repository?.close();
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

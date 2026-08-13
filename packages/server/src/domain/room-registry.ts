import { Room } from "./room.js";
import type { RoomRepository } from "../ports/room-repository.js";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly repository: RoomRepository | null = null) {}

  static restore(repository: RoomRepository): RoomRegistry {
    const registry = new RoomRegistry(repository);
    for (const record of repository.loadAll()) {
      const room = Room.restore(record);
      if (registry.rooms.has(room.roomId)) {
        throw new Error(`중복 저장된 roomId: ${room.roomId}`);
      }
      registry.rooms.set(room.roomId, room);
    }
    return registry;
  }

  create(options: { roomId: string; token: string; name?: string }): Room {
    if (this.rooms.has(options.roomId)) {
      throw new Error(`이미 존재하는 roomId: ${options.roomId}`);
    }

    const room = new Room(options);
    this.rooms.set(options.roomId, room);
    this.repository?.save(room.record());
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  remove(roomId: string): void {
    this.rooms.delete(roomId);
    this.repository?.delete(roomId);
  }

  save(room: Room): void {
    if (this.rooms.get(room.roomId) !== room) {
      throw new Error(`registry가 소유하지 않은 Room은 저장할 수 없다: ${room.roomId}`);
    }
    this.repository?.save(room.record());
  }

  close(): void {
    this.repository?.close();
  }
}

import { Room } from "./room.js";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  create(options: { roomId: string; token: string }): Room {
    if (this.rooms.has(options.roomId)) {
      throw new Error(`이미 존재하는 roomId: ${options.roomId}`);
    }

    const room = new Room(options);
    this.rooms.set(options.roomId, room);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  remove(roomId: string): void {
    this.rooms.delete(roomId);
  }
}

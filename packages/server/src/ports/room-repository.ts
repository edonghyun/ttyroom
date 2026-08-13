import type { StoredRoomRecord } from "../domain/room.js";

export interface RoomRepository {
  loadAll(): StoredRoomRecord[];
  save(record: StoredRoomRecord): void;
  delete(roomId: string): void;
  close(): void;
}

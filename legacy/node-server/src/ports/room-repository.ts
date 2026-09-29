import type { StoredRoomRecord } from "../domain/room.js";

export interface RoomRepository {
  loadAll(): Promise<StoredRoomRecord[]>;
  save(record: StoredRoomRecord): Promise<void>;
  delete(roomId: string): Promise<void>;
  close(): Promise<void>;
}

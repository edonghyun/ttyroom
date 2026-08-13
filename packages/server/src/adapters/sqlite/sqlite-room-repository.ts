import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredRoomRecord } from "../../domain/room.js";
import { storedRoomRecordSchema } from "../../domain/room-record.js";
import type { RoomRepository } from "../../ports/room-repository.js";

interface StoredRow {
  record_json: string;
}

export class SqliteRoomRepository implements RoomRepository {
  private readonly database: DatabaseSync;
  private readonly loadStatement;
  private readonly saveStatement;
  private readonly deleteStatement;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      ) STRICT;
    `);
    this.loadStatement = this.database.prepare("SELECT record_json FROM rooms ORDER BY room_id");
    this.saveStatement = this.database.prepare(`
      INSERT INTO rooms (room_id, record_json)
      VALUES (?, ?)
      ON CONFLICT(room_id) DO UPDATE SET record_json = excluded.record_json
    `);
    this.deleteStatement = this.database.prepare("DELETE FROM rooms WHERE room_id = ?");
  }

  loadAll(): StoredRoomRecord[] {
    return (this.loadStatement.all() as unknown as StoredRow[]).map((row) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.record_json);
      } catch (error) {
        throw new Error("저장된 Room 레코드가 유효한 JSON이 아니다", { cause: error });
      }
      return storedRoomRecordSchema.parse(parsed);
    });
  }

  save(record: StoredRoomRecord): void {
    const validated = storedRoomRecordSchema.parse(record);
    this.saveStatement.run(validated.roomId, JSON.stringify(validated));
  }

  delete(roomId: string): void {
    this.deleteStatement.run(roomId);
  }

  close(): void {
    this.database.close();
  }
}

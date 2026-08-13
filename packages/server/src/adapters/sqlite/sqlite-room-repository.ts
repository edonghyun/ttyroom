import { Worker } from "node:worker_threads";
import type { StoredRoomRecord } from "../../domain/room.js";
import { storedRoomRecordSchema } from "../../domain/room-record.js";
import type { RoomRepository } from "../../ports/room-repository.js";
import { runSqliteRoomRepositoryWorker } from "./sqlite-room-repository-worker.js";

interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: { name: string; message: string; stack?: string };
}

export class SqliteRoomRepository implements RoomRepository {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private nextRequestId = 1;
  private state: "open" | "closing" | "closed" | "failed" = "open";
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;

  constructor(path: string, options: { createWorker?: (path: string) => Worker } = {}) {
    this.worker =
      options.createWorker?.(path) ??
      new Worker(`void (${runSqliteRoomRepositoryWorker.toString()})()`, {
        eval: true,
        workerData: { path },
      });
    this.worker.on("message", (response: WorkerResponse) => this.receive(response));
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (this.state !== "closed") this.fail(new Error(`SQLite worker 종료 코드: ${code}`));
    });
  }

  async loadAll(): Promise<StoredRoomRecord[]> {
    const rows = await this.request<string[]>({ operation: "loadAll" });
    return rows.map((recordJson) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(recordJson);
      } catch (error) {
        throw new Error("저장된 Room 레코드가 유효한 JSON이 아니다", { cause: error });
      }
      return storedRoomRecordSchema.parse(parsed);
    });
  }

  async save(record: StoredRoomRecord): Promise<void> {
    const validated = storedRoomRecordSchema.parse(record);
    await this.request({
      operation: "save",
      roomId: validated.roomId,
      recordJson: JSON.stringify(validated),
    });
  }

  async delete(roomId: string): Promise<void> {
    await this.request({ operation: "delete", roomId });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === "closed") return Promise.resolve();
    if (this.state === "failed") return Promise.reject(this.failure);
    this.state = "closing";
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    await this.request({ operation: "close" });
    this.state = "closed";
    await this.worker.terminate();
  }

  private request<T = void>(request: {
    operation: "loadAll" | "save" | "delete" | "close";
    roomId?: string;
    recordJson?: string;
  }): Promise<T> {
    if (this.state !== "open" && !(this.state === "closing" && request.operation === "close")) {
      return Promise.reject(new Error("닫히는 중이거나 닫힌 Room 저장소는 사용할 수 없다"));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.worker.postMessage({ id, ...request });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private receive(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (!response.error) {
      pending.resolve(response.result);
      return;
    }
    const error = new Error(response.error.message);
    error.name = response.error.name;
    if (response.error.stack) error.stack = response.error.stack;
    pending.reject(error);
  }

  private fail(error: Error): void {
    if (this.state === "closed" || this.state === "failed") return;
    this.state = "failed";
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

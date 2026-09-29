import type { StoredRoomRecord } from "../domain/room.js";
import type { RoomRepository } from "../ports/room-repository.js";

export interface DeferredRepositoryCall {
  readonly started: Promise<void>;
  release(): void;
}

export class RecordingRoomRepository implements RoomRepository {
  readonly savedRecords: StoredRoomRecord[] = [];
  readonly deletedRoomIds: string[] = [];
  private saveFailure: Error | undefined;
  private deleteFailure: Error | undefined;
  private delayEverySave = false;
  private nextSave: OperationGate | undefined;
  private nextDelete: OperationGate | undefined;

  constructor(private readonly restoredRecords: StoredRoomRecord[] = []) {}

  failSavesWith(error: Error): void {
    this.saveFailure = error;
  }

  failDeletesWith(error: Error): void {
    this.deleteFailure = error;
  }

  delayEverySaveUntilNextTurn(): void {
    this.delayEverySave = true;
  }

  deferNextSave(): DeferredRepositoryCall {
    return (this.nextSave = new OperationGate());
  }

  deferNextDelete(): DeferredRepositoryCall {
    return (this.nextDelete = new OperationGate());
  }

  async loadAll(): Promise<StoredRoomRecord[]> {
    return structuredClone(this.restoredRecords);
  }

  async save(record: StoredRoomRecord): Promise<void> {
    if (this.delayEverySave) await new Promise<void>((resolve) => setImmediate(resolve));
    const gate = this.nextSave;
    this.nextSave = undefined;
    await gate?.wait();
    if (this.saveFailure) throw this.saveFailure;
    this.savedRecords.push(structuredClone(record));
  }

  async delete(roomId: string): Promise<void> {
    const gate = this.nextDelete;
    this.nextDelete = undefined;
    await gate?.wait();
    if (this.deleteFailure) throw this.deleteFailure;
    this.deletedRoomIds.push(roomId);
  }

  async close(): Promise<void> {}
}

class OperationGate implements DeferredRepositoryCall {
  readonly started: Promise<void>;
  private readonly markStarted: () => void;
  private readonly released: Promise<void>;
  private readonly markReleased: () => void;

  constructor() {
    const started = deferred();
    const released = deferred();
    this.started = started.promise;
    this.markStarted = started.resolve;
    this.released = released.promise;
    this.markReleased = released.resolve;
  }

  async wait(): Promise<void> {
    this.markStarted();
    await this.released;
  }

  release(): void {
    this.markReleased();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

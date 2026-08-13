interface WorkerRequest {
  id: number;
  operation: "loadAll" | "save" | "delete" | "close";
  roomId?: string;
  recordJson?: string;
}

interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: { name: string; message: string; stack?: string };
}

export async function runSqliteRoomRepositoryWorker(): Promise<void> {
  function requireValue<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("SQLite worker 요청 값이 누락됐다");
    return value;
  }

  function serializeError(error: unknown): { name: string; message: string; stack?: string } {
    if (!(error instanceof Error)) return { name: "Error", message: String(error) };
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  const importModule = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  const [{ mkdirSync }, { dirname }, { DatabaseSync }, { parentPort, workerData }] =
    (await Promise.all([
      importModule("node:fs"),
      importModule("node:path"),
      importModule("node:sqlite"),
      importModule("node:worker_threads"),
    ])) as unknown as [
      typeof import("node:fs"),
      typeof import("node:path"),
      typeof import("node:sqlite"),
      typeof import("node:worker_threads"),
    ];

  if (!parentPort) throw new Error("SQLite worker에 parentPort가 없다");
  const path = (workerData as { path: string }).path;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const database = new DatabaseSync(path, { timeout: 5_000 });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    ) STRICT;
  `);
  const loadStatement = database.prepare("SELECT record_json FROM rooms ORDER BY room_id");
  const saveStatement = database.prepare(`
    INSERT INTO rooms (room_id, record_json)
    VALUES (?, ?)
    ON CONFLICT(room_id) DO UPDATE SET record_json = excluded.record_json
  `);
  const deleteStatement = database.prepare("DELETE FROM rooms WHERE room_id = ?");

  parentPort.on("message", (request: WorkerRequest) => {
    try {
      let result: unknown;
      switch (request.operation) {
        case "loadAll":
          result = (loadStatement.all() as Array<{ record_json: string }>).map(
            (row) => row.record_json,
          );
          break;
        case "save":
          saveStatement.run(requireValue(request.roomId), requireValue(request.recordJson));
          break;
        case "delete":
          deleteStatement.run(requireValue(request.roomId));
          break;
        case "close":
          database.close();
          break;
      }
      const response: WorkerResponse = { id: request.id, result };
      parentPort.postMessage(response);
      if (request.operation === "close") parentPort.close();
    } catch (error) {
      const response: WorkerResponse = { id: request.id, error: serializeError(error) };
      parentPort.postMessage(response);
    }
  });
}

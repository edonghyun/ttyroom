import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TestProcess } from "./test-process.js";
import { waitUntil } from "./wait-until.js";

// Public configuration contract, deliberately independent of server source/types.
export interface TestPolicy {
  participantGraceMs: number;
  hostGraceMs: number;
  scrollbackBytesPerTerminal: number;
  sendBufferDropThresholdBytes: number;
  maxQueuedDataBytesPerConnection: number;
  outputRateLimitBytesPerSec: number;
}

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../..");
export interface TestCapacity {
  membershipsPerRoom: number;
  memberships: number;
  credentialsPerRoom: number;
  credentials: number;
  rooms: number;
  connections: number;
  terminals: number;
  retainedHistoryBytes: number;
}

export interface LaunchOptions {
  capacity?: Partial<TestCapacity>;
  command?: readonly [string, ...string[]];
  startupTimeoutMs?: number;
  protocolVersion?: 7 | 8;
}

/** Starts an actual executable and discovers readiness over stdout plus HTTP.
 * Each instance owns a disposable config/SQLite directory; restart preserves it.
 */
export class ServerProcess {
  private process: TestProcess | undefined;
  private closed = false;
  private endpoint = "";
  private stateGeneration = 0;

  private constructor(
    private readonly directory: string,
    private readonly policy: Partial<TestPolicy>,
    private readonly command: readonly [string, ...string[]],
    private readonly startupTimeoutMs: number,
    private readonly protocolVersion?: 7 | 8,
    private readonly capacity?: Partial<TestCapacity>,
  ) {}

  static async start(
    policy: Partial<TestPolicy> = {},
    options: LaunchOptions = {},
  ): Promise<ServerProcess> {
    const command = options.command ?? configuredCommand();
    const directory = await mkdtemp(join(tmpdir(), "ttyroom-e2e-"));
    const server = new ServerProcess(
      directory,
      policy,
      command,
      options.startupTimeoutMs ?? 10_000,
      options.protocolVersion,
      options.capacity,
    );
    try {
      await server.launch(0);
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  get baseUrl(): string {
    return this.endpoint;
  }

  get pid(): number | undefined {
    return this.process?.child.pid;
  }

  diagnostics(): string {
    return this.process?.diagnostics() ?? "server not started";
  }

  /** Physical SQLite footprint, including any sidecars; contains no stored values. */
  async storageBytes(): Promise<number> {
    const file = join(this.directory, `state-${this.stateGeneration}.sqlite`);
    const sizes = await Promise.all(
      ["", "-wal", "-shm", "-journal"].map(async (suffix) => {
        try {
          return (await stat(file + suffix)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw error;
        }
      }),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  async restart(downtimeMs = 0): Promise<void> {
    if (this.closed) throw new Error("닫힌 테스트 서버는 재시작할 수 없다");
    const url = this.endpoint;
    await this.process?.stop();
    // Intentional fault duration, not a synchronization sleep.
    if (downtimeMs > 0) await delay(downtimeMs);
    await this.launch(Number(new URL(url).port));
    if (this.endpoint !== url) throw new Error(`서버 주소 변경: ${url} -> ${this.endpoint}`);
  }

  /** Test fault: restart at the same address with a fresh database, retaining old files for cleanup. */
  async restartWithoutRooms(): Promise<void> {
    if (this.closed) throw new Error("닫힌 테스트 서버는 재시작할 수 없다");
    this.stateGeneration += 1;
    await this.restart();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.process?.stop();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async launch(port: number): Promise<void> {
    const statePath = join(this.directory, `state-${this.stateGeneration}.sqlite`);
    const configPath = join(this.directory, "ttyroom.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        port,
        statePath,
        policy: this.policy,
        capacity: this.capacity,
        protocolVersion: this.protocolVersion,
      }),
    );
    // Prevent developer configuration from leaking into otherwise isolated tests.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("TTYROOM_")),
    );
    this.process = new TestProcess(this.command, this.directory, {
      ...env,
      TTYROOM_PORT: String(port),
      TTYROOM_STATE_PATH: statePath,
      TTYROOM_CONFIG_PATH: configPath,
    });
    let announcedUrl = "";
    try {
      await waitUntil(
        async () => {
          if (this.process!.exited()) throw new Error("server exited before readiness");
          const match = this.process!.diagnostics().match(
            /TTYRoom server listening at (http:\/\/127\.0\.0\.1:\d+)/,
          );
          if (!match?.[1]) return false;
          announcedUrl = match[1];
          try {
            const response = await fetch(`${announcedUrl}/healthz`, {
              signal: AbortSignal.timeout(500),
            });
            return response.status === 200 && (await response.text()) === "ok";
          } catch {
            return false;
          }
        },
        { timeoutMs: this.startupTimeoutMs },
      );
    } catch (error) {
      throw new Error(`server startup failed: ${String(error)}\n${this.diagnostics()}`);
    }
    this.endpoint = announcedUrl;
  }
}

function configuredCommand(): readonly [string, ...string[]] {
  const raw = process.env.TTYROOM_E2E_SERVER_COMMAND;
  if (!raw) return [process.execPath, resolve(WORKSPACE_ROOT, "legacy/node-server/dist/index.js")];
  const command: unknown = JSON.parse(raw);
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new Error(
      "TTYROOM_E2E_SERVER_COMMAND must be a nonempty JSON array of executable and arguments",
    );
  }
  return command as [string, ...string[]];
}

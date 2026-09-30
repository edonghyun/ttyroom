import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const execute = promisify(execFile);

/** Serial sampling avoids overlapping ps processes. RSS excludes descendants. */
export class ProcessMemory {
  readonly samples: { observedAtMs: number; serverKiB: number; connectorKiB: number }[] = [];
  readonly failures: { observedAtMs: number }[] = [];
  private readonly stopSignal = new AbortController();
  private readonly completion: Promise<void>;

  constructor(pids: { server: number; connector: number }) {
    this.completion = this.sample(pids);
  }

  async stop(): Promise<void> {
    this.stopSignal.abort();
    await this.completion;
  }

  private async sample(pids: { server: number; connector: number }): Promise<void> {
    while (!this.stopSignal.signal.aborted) {
      try {
        const { stdout } = await execute(
          "ps",
          ["-o", "pid=,rss=", "-p", `${pids.server},${pids.connector}`],
          { timeout: 2_000 },
        );
        const rows = new Map(
          stdout
            .trim()
            .split("\n")
            .map((line) => {
              const [pid, rss] = line.trim().split(/\s+/).map(Number);
              return [pid, rss] as const;
            }),
        );
        const serverKiB = rows.get(pids.server);
        const connectorKiB = rows.get(pids.connector);
        if (!serverKiB || !connectorKiB) throw new Error("Missing RSS sample");
        this.samples.push({ observedAtMs: performance.now(), serverKiB, connectorKiB });
      } catch {
        this.failures.push({ observedAtMs: performance.now() });
      }
      await setTimeout(200, undefined, { signal: this.stopSignal.signal }).catch(() => {});
    }
  }
}

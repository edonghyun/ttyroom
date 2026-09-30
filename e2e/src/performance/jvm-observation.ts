import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { heapUsed, summarizeFlight, type FlightEvent } from "./capacity-report.js";

const execute = promisify(execFile);
/** Finite diagnostics and serial RSS sampling. Full GC runs only outside timed traffic. */
export class JvmObservation {
  readonly samples: {
    at: string;
    serverRssBytes: number;
    generatorRssBytes: number;
    sampleMs: number;
  }[] = [];
  readonly failures: string[] = [];
  private readonly stopSignal = new AbortController();
  private readonly sampling: Promise<void>;
  constructor(
    readonly pid: number,
    private readonly javaHome: string,
    readonly directory: string,
  ) {
    this.sampling = this.sample();
  }
  private async command(...args: string[]) {
    return (
      await execute(resolve(this.javaHome, "bin/jcmd"), [String(this.pid), ...args], {
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  }
  async startRecording(settings: string) {
    await this.command("JFR.start", "name=capacity", `settings=${settings}`, "maxsize=64m");
  }
  async postGcHeap(phase: string) {
    const started = performance.now();
    await this.command("GC.run");
    const raw = await this.command("GC.heap_info");
    await writeFile(resolve(this.directory, `heap-${phase}.txt`), raw);
    return {
      phase,
      at: new Date().toISOString(),
      usedBytes: heapUsed(raw),
      diagnosticMs: performance.now() - started,
    };
  }
  async recording(startMs: number, endMs: number) {
    const file = resolve(this.directory, "server.jfr");
    await this.command("JFR.stop", "name=capacity", `filename=${file}`);
    const { stdout } = await execute(
      resolve(this.javaHome, "bin/jfr"),
      [
        "print",
        "--json",
        "--events",
        "ttyroom.*,jdk.GarbageCollection,jdk.GCHeapSummary,jdk.CPULoad,jdk.DataLoss",
        file,
      ],
      { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 },
    );
    await writeFile(resolve(this.directory, "flight.json"), stdout);
    const events = (JSON.parse(stdout) as { recording: { events: FlightEvent[] } }).recording
      .events;
    return summarizeFlight(events, startMs, endMs);
  }
  async stop() {
    this.stopSignal.abort();
    await this.sampling;
  }
  private async sample() {
    while (!this.stopSignal.signal.aborted) {
      const started = performance.now();
      try {
        const { stdout } = await execute("ps", ["-o", "rss=", "-p", String(this.pid)], {
          timeout: 2000,
        });
        const serverRssBytes = Number(stdout.trim()) * 1024;
        if (!Number.isFinite(serverRssBytes) || serverRssBytes <= 0) throw new Error("Missing RSS");
        this.samples.push({
          at: new Date().toISOString(),
          serverRssBytes,
          generatorRssBytes: process.memoryUsage().rss,
          sampleMs: performance.now() - started,
        });
      } catch {
        this.failures.push(new Date().toISOString());
      }
      await delay(1000, undefined, { signal: this.stopSignal.signal }).catch(() => {});
    }
  }
}

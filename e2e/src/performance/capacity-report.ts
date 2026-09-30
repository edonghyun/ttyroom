/** Fixed memory, 1 ms upper-bound buckets. Values above 1000 ms stay explicit. */
export class Latencies {
  readonly buckets = new Array<number>(1002).fill(0);
  count = 0;
  maxMs = 0;
  add(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid latency");
    this.buckets[Math.min(1001, Math.ceil(ms))]!++;
    this.count++;
    this.maxMs = Math.max(this.maxMs, ms);
  }
  summary() {
    const rank = Math.ceil(this.count * 0.95);
    let seen = 0;
    let p95UpperMs: number | null = null;
    if (this.count)
      for (let i = 0; i <= 1000; i++) {
        seen += this.buckets[i]!;
        if (seen >= rank) {
          p95UpperMs = i;
          break;
        }
      }
    return {
      count: this.count,
      p95UpperMs,
      maxMs: this.maxMs,
      over1000Ms: this.buckets[1001]!,
      buckets: this.buckets,
    };
  }
}

export function heapUsed(text: string) {
  const match = text.match(/garbage-first heap\s+total\s+\d+K, used (\d+)K/);
  if (!match) throw new Error("Missing G1 heap observation");
  return Number(match[1]) * 1024;
}

export function assess(load: {
  completed: boolean;
  expectedFrames: number;
  receivedFrames: number;
  gaps: number;
  sequenceErrors: number;
  output: ReturnType<Latencies["summary"]>;
  control: ReturnType<Latencies["summary"]>;
  maxScheduleLagMs: number;
}) {
  const failures: string[] = [];
  if (!load.completed) failures.push("incomplete workload");
  if (load.expectedFrames <= 0 || load.receivedFrames !== load.expectedFrames)
    failures.push("missing or extra output");
  if (load.gaps || load.sequenceErrors) failures.push("output continuity lost");
  if (
    !load.output.count ||
    load.output.p95UpperMs === null ||
    load.output.p95UpperMs > 100 ||
    load.output.maxMs > 1000
  )
    failures.push("output latency budget");
  if (
    !load.control.count ||
    load.control.p95UpperMs === null ||
    load.control.p95UpperMs > 250 ||
    load.control.maxMs > 1000
  )
    failures.push("control latency budget");
  if (load.maxScheduleLagMs > 250) failures.push("load generator late");
  return failures;
}

export interface FlightEvent {
  type: string;
  values: Record<string, unknown>;
}
export function summarizeFlight(events: FlightEvent[], startMs: number, endMs: number) {
  const queue = new Latencies();
  const pressure: Record<string, number> = {};
  const gc: { at: string; pauseMs: number; cause: string }[] = [];
  const heap: { at: string; when: string; usedBytes: number }[] = [];
  const cpu: { at: string; jvmFractionOfMachine: number }[] = [];
  let lostBytes = 0;
  for (const { type, values: v } of events) {
    const at = String(v.startTime);
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp)) throw new Error("Invalid JFR timestamp");
    if (type === "jdk.DataLoss") lostBytes += Number(v.amount);
    if (timestamp < startMs || timestamp > endMs) continue;
    if (type === "ttyroom.ControlQueueWait") queue.add(durationMs(v.duration));
    else if (type === "ttyroom.BufferPressure") {
      const key = `${v.boundary}:${v.outcome}`;
      pressure[key] = (pressure[key] ?? 0) + 1;
    } else if (type === "jdk.GarbageCollection")
      gc.push({ at, pauseMs: durationMs(v.sumOfPauses), cause: String(v.cause) });
    else if (type === "jdk.GCHeapSummary")
      heap.push({ at, when: String(v.when), usedBytes: Number(v.heapUsed) });
    else if (type === "jdk.CPULoad")
      cpu.push({ at, jvmFractionOfMachine: Number(v.jvmUser) + Number(v.jvmSystem) });
  }
  if (!cpu.length || !queue.count || !Number.isFinite(lostBytes) || lostBytes > 0)
    throw new Error("Incomplete JFR observations");
  return { queue: queue.summary(), pressure, gc, heap, cpu, lostBytes };
}
function durationMs(value: unknown) {
  const match = String(value).match(/^PT([0-9.]+)S$/);
  if (!match) throw new Error(`Invalid JFR duration: ${value}`);
  return Number(match[1]) * 1000;
}

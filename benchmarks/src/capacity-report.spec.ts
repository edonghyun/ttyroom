import { describe, expect, it } from "vitest";
import { assess, heapUsed, Latencies, summarizeFlight } from "./capacity-report.js";

describe("capacity evidence", () => {
  it("bounds histogram memory and exposes overflow instead of reporting an optimistic percentile", () => {
    const latency = new Latencies();
    latency.add(0.2);
    latency.add(1001);
    const observed = latency.summary();
    expect(observed).toMatchObject({ count: 2, p95UpperMs: null, over1000Ms: 1, maxMs: 1001 });
    expect(observed.buckets).toHaveLength(1002);
  });
  it("keeps an observation stable when late samples arrive", () => {
    const latency = new Latencies();
    latency.add(1);

    const observed = latency.summary();
    latency.add(2);

    expect(observed.count).toBe(1);
    expect(observed.buckets[2]).toBe(0);
  });

  it("never calls an empty run or a run with missing output successful", () => {
    const output = new Latencies();
    const control = new Latencies();
    const empty = assess({
      completed: true,
      expectedFrames: 0,
      receivedFrames: 0,
      gaps: 0,
      sequenceErrors: 0,
      output: output.summary(),
      control: control.summary(),
      maxScheduleLagMs: 0,
    });
    output.add(1);
    control.add(1);
    const missing = assess({
      completed: true,
      expectedFrames: 2,
      receivedFrames: 1,
      gaps: 0,
      sequenceErrors: 0,
      output: output.summary(),
      control: control.summary(),
      maxScheduleLagMs: 0,
    });
    expect(empty).toContain("missing or extra output");
    expect(empty).toContain("output latency budget");
    expect(missing).toEqual(["missing or extra output"]);
  });
  it("rejects latency and generator lag even when all frames arrive", () => {
    const output = new Latencies();
    output.add(101);
    const control = new Latencies();
    control.add(251);
    const failures = assess({
      completed: true,
      expectedFrames: 1,
      receivedFrames: 1,
      gaps: 0,
      sequenceErrors: 0,
      output: output.summary(),
      control: control.summary(),
      maxScheduleLagMs: 251,
    });
    expect(failures).toEqual([
      "output latency budget",
      "control latency budget",
      "load generator late",
    ]);
  });
  it("does not turn an unavailable heap observation into zero bytes", () => {
    const used = heapUsed("garbage-first heap total 262144K, used 24000K [address]");
    expect(used).toBe(24000 * 1024);
    expect(() => heapUsed("attach failed")).toThrow("Missing G1");
  });
  it("separates timed JFR observations from forced-GC diagnostics outside the load window", () => {
    const start = Date.parse("2026-09-30T00:00:00Z");
    const flight = summarizeFlight(
      [
        {
          type: "jdk.GarbageCollection",
          values: { startTime: "2026-09-29T23:59:59Z", sumOfPauses: "PT1S", cause: "System.gc()" },
        },
        {
          type: "jdk.CPULoad",
          values: { startTime: "2026-09-30T00:00:01Z", jvmUser: 0.1, jvmSystem: 0.02 },
        },
        {
          type: "ttyroom.ControlQueueWait",
          values: { startTime: "2026-09-30T00:00:01Z", duration: "PT0.0012S" },
        },
        {
          type: "ttyroom.BufferPressure",
          values: { startTime: "2026-09-30T00:00:01Z", boundary: "outbound", outcome: "live-drop" },
        },
      ],
      start,
      start + 2000,
    );
    expect(flight.gc).toEqual([]);
    expect(flight.queue.p95UpperMs).toBe(2);
    expect(flight.pressure).toEqual({ "outbound:live-drop": 1 });
    expect(() => summarizeFlight([], start, start + 2000)).toThrow("Incomplete JFR");
  });
});

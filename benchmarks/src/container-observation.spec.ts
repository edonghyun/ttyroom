import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureDockerOutput, type DockerCommand } from "./docker-measurement.js";
import { describe, expect, it, vi } from "vitest";
import { checkContainerSample, parseContainerSample } from "./container-observation.js";

const MiB = 1024 ** 2;
function observation(overrides: Partial<ReturnType<typeof parseContainerSample>> = {}) {
  return {
    atMs: 1000,
    memoryBytes: 200 * MiB,
    memoryLimitBytes: 1024 * MiB,
    rssBytes: 150 * MiB,
    cpuCount: 2,
    usageUsec: 100_000,
    periods: 10,
    throttledPeriods: 0,
    throttledUsec: 0,
    oom: 0,
    oomKills: 0,
    ...overrides,
  };
}
const raw = `[cpu.max]
200000 100000
[cpu.stat]
usage_usec 100000
nr_periods 10
nr_throttled 0
throttled_usec 0
[memory.current]
209715200
[memory.max]
1073741824
[memory.swap.max]
0
[memory.events]
low 0
high 0
max 0
oom 0
oom_kill 0
[status]
Name: java
VmRSS: 153600 kB
`;

describe("container measurement contract", () => {
  it("keeps container memory, JVM RSS and CPU quota as separate observations", () => {
    expect(parseContainerSample(raw, 1000)).toEqual(observation());
  });

  it.each([
    ["missing counter", raw.replace("oom_kill 0\n", "")],
    ["unlimited memory", raw.replace("1073741824", "max")],
    ["invalid quota", raw.replace("200000 100000", "max 100000")],
    ["enabled swap", raw.replace("[memory.swap.max]\n0", "[memory.swap.max]\n1024")],
    ["missing process", raw.replace("VmRSS: 153600 kB", "")],
  ])("rejects %s rather than inventing zero usage", (_, sample) => {
    expect(() => parseContainerSample(sample, 1000)).toThrow();
  });

  it.each([
    ["memory safety budget", { memoryBytes: Math.ceil(1024 * MiB * 0.9) }],
    ["JVM RSS safety budget", { rssBytes: 768 * MiB + 1 }],
    ["container OOM", { oom: 1 }],
    ["container OOM", { oomKills: 1 }],
  ])("stops on %s before allowing another load stage", (reason, sample) => {
    expect(checkContainerSample(observation(sample), undefined, "server").failures).toContain(
      reason,
    );
  });

  it("applies the generator's smaller memory budget", () => {
    const sample = observation({
      cpuCount: 1,
      memoryLimitBytes: 512 * MiB,
      memoryBytes: 461 * MiB,
    });
    expect(checkContainerSample(sample, undefined, "generator").failures).toEqual([
      "memory safety budget",
    ]);
  });

  it("records CPU quota use and throttling without declaring a latency failure", () => {
    const previous = observation();
    const current = observation({
      atMs: 2000,
      usageUsec: 1_100_000,
      periods: 20,
      throttledPeriods: 5,
      throttledUsec: 200_000,
    });
    expect(checkContainerSample(current, previous, "server")).toEqual({
      failures: [],
      cpu: { quotaUsedFraction: 0.5, throttledPeriodFraction: 0.5, throttledUsec: 200_000 },
    });
  });

  it.each([
    ["counter reset", { atMs: 2000, usageUsec: 1 }],
    ["sampling gap", { atMs: 4001 }],
    ["nonmonotonic clock", { atMs: 1000 }],
    ["changed limits", { atMs: 2000, cpuCount: 1 }],
  ])("invalidates observations after %s", (_, next) => {
    expect(checkContainerSample(observation(next), observation(), "server").failures).toContain(
      "invalid observation interval",
    );
  });
});

describe("external load watchdog", () => {
  it("observes both containers before releasing load and stops before returning success", async () => {
    await using trial = await givenTrial();

    const result = await trial.measure();

    expect(result.completed).toBe(true);
    expect(trial.actions.slice(0, 4)).toEqual([
      "server-sample",
      "generator-sample",
      "load-state",
      "release-load",
    ]);
    expect(trial.actions.at(-1)).toBe("watchdog-stop-load");
    expect(await trial.savedResult()).toEqual(result);
  });

  it("does not release load when the initial memory observation is unsafe", async () => {
    await using trial = await givenTrial({ serverSample: raw.replace("209715200", "1000000000") });

    const result = await trial.measure();

    expect(result.completed).toBe(false);
    expect(result.failures).toEqual(["Error: server: memory safety budget"]);
    expect(trial.actions).not.toContain("release-load");
    expect(trial.actions.at(-1)).toBe("watchdog-stop-load");
  });

  it("keeps load blocked when successful commands have made the first observations stale", async () => {
    await using trial = await givenTrial({ delayedCommands: true });

    const result = await trial.measure();

    expect(result.completed).toBe(false);
    expect(trial.actions).not.toContain("release-load");
    expect(result.failures).toEqual(["Error: Container observations became stale"]);
    expect(trial.actions.at(-1)).toBe("watchdog-stop-load");
  });

  it("stops a running workload when sampling becomes unavailable", async () => {
    await using trial = await givenTrial({ loseSamplerAfterRelease: true });

    const result = await trial.measure();

    expect(result.completed).toBe(false);
    expect(result.released).toBe(true);
    expect(result.failures).toEqual(["Error: container disappeared"]);
    expect(trial.actions.at(-1)).toBe("watchdog-stop-load");
  });

  it("preserves the load failure and a failed stop as separate failures", async () => {
    await using trial = await givenTrial({
      loadFailures: ["output continuity lost"],
      cannotStop: true,
    });

    const result = await trial.measure();

    expect(result.completed).toBe(false);
    expect(result.failures).toEqual([
      "Error: Load failed: output continuity lost",
      "Error: daemon unavailable during stop",
    ]);
    expect(await trial.savedResult()).toEqual(result);
  });
});

// Commands are the external boundary. Tests drive observations and outcomes, not Docker internals.
async function givenTrial(
  options: {
    serverSample?: string;
    delayedCommands?: boolean;
    loseSamplerAfterRelease?: boolean;
    loadFailures?: string[];
    cannotStop?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ttyroom-watchdog-"));
  const actions: string[] = [];
  let released = false;
  let elapsedMs = 0;
  const clock = options.delayedCommands
    ? vi.spyOn(performance, "now").mockImplementation(() => elapsedMs)
    : undefined;
  const run: DockerCommand = async (_args, label) => {
    actions.push(label);
    if (label === "server-sample") {
      if (released && options.loseSamplerAfterRelease) throw new Error("container disappeared");
      return options.serverSample ?? raw;
    }
    if (label === "generator-sample" && options.delayedCommands) elapsedMs += 1600;
    if (label === "generator-sample")
      return raw.replace("200000 100000", "100000 100000").replace("1073741824", "536870912");
    if (label === "load-state" && options.delayedCommands) elapsedMs += 1600;
    if (label === "load-state") return released ? "done" : "ready";
    if (label === "release-load") released = true;
    if (label === "load-result")
      return JSON.stringify({
        completed: !options.loadFailures?.length,
        failures: options.loadFailures ?? [],
      });
    if (label === "watchdog-stop-load" && options.cannotStop)
      throw new Error("daemon unavailable during stop");
    return "";
  };
  const output = join(directory, "trial");
  return {
    actions,
    measure: () => measureDockerOutput(run, "server", "generator", output, 10_000),
    savedResult: async () => JSON.parse(await readFile(join(output, "watchdog.json"), "utf8")),
    [Symbol.asyncDispose]: async () => {
      clock?.mockRestore();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

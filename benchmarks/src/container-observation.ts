/** cgroup v2 counters belong to the container, not the Docker CLI process. */
export interface ContainerSample {
  atMs: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  rssBytes: number;
  cpuCount: number;
  usageUsec: number;
  periods: number;
  throttledPeriods: number;
  throttledUsec: number;
  oom: number;
  oomKills: number;
}

export function parseContainerSample(raw: string, atMs: number): ContainerSample {
  const sections = new Map<string, string>();
  for (const match of raw.matchAll(/^\[([^\]]+)\]\n([^[]*)/gm))
    sections.set(match[1]!, match[2]!.trim());
  const number = (text: string | undefined) => {
    if (!text || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
      throw new Error("Missing or invalid container observation");
    return Number(text);
  };
  const counter = (section: string, key: string) =>
    number(sections.get(section)?.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1]);
  const [quota, period] = (sections.get("cpu.max") ?? "").split(/\s+/);
  const cpuCount = number(quota) / number(period);
  const memoryLimitBytes = number(sections.get("memory.max"));
  if (!Number.isFinite(atMs) || !Number.isFinite(cpuCount) || cpuCount <= 0 || !memoryLimitBytes)
    throw new Error("Invalid container limits or timestamp");
  if (number(sections.get("memory.swap.max")) !== 0)
    throw new Error("Benchmark swap must be disabled");
  return {
    atMs,
    memoryBytes: number(sections.get("memory.current")),
    memoryLimitBytes,
    rssBytes: number(sections.get("status")?.match(/^VmRSS:\s+(\d+) kB$/m)?.[1]) * 1024,
    cpuCount,
    usageUsec: counter("cpu.stat", "usage_usec"),
    periods: counter("cpu.stat", "nr_periods"),
    throttledPeriods: counter("cpu.stat", "nr_throttled"),
    throttledUsec: counter("cpu.stat", "throttled_usec"),
    oom: counter("memory.events", "oom"),
    oomKills: counter("memory.events", "oom_kill"),
  };
}

export function checkContainerSample(
  current: ContainerSample,
  previous: ContainerSample | undefined,
  role: "server" | "generator",
) {
  const failures: string[] = [];
  if (current.memoryBytes >= current.memoryLimitBytes * 0.9) failures.push("memory safety budget");
  if (role === "server" && current.rssBytes > 768 * 1024 ** 2)
    failures.push("JVM RSS safety budget");
  if (current.oom || current.oomKills) failures.push("container OOM");
  let cpu:
    | { quotaUsedFraction: number; throttledPeriodFraction: number | null; throttledUsec: number }
    | undefined;
  if (previous) {
    const elapsedMs = current.atMs - previous.atMs;
    const counters = [
      "usageUsec",
      "periods",
      "throttledPeriods",
      "throttledUsec",
      "oom",
      "oomKills",
    ] as const;
    if (
      elapsedMs <= 0 ||
      elapsedMs > 3000 ||
      current.cpuCount !== previous.cpuCount ||
      current.memoryLimitBytes !== previous.memoryLimitBytes ||
      counters.some((key) => current[key] < previous[key])
    ) {
      failures.push("invalid observation interval");
    } else {
      const periods = current.periods - previous.periods;
      cpu = {
        quotaUsedFraction:
          (current.usageUsec - previous.usageUsec) / (elapsedMs * 1000 * current.cpuCount),
        throttledPeriodFraction: periods
          ? (current.throttledPeriods - previous.throttledPeriods) / periods
          : null,
        throttledUsec: current.throttledUsec - previous.throttledUsec,
      };
    }
  }
  return { failures, cpu };
}

// POSIX sh is part of the two fixed Linux images. No host PID/path assumptions.
export const containerSampleCommand =
  'set -eu; for file in cpu.max cpu.stat memory.current memory.max memory.swap.max memory.events; do printf "[%s]\\n" "$file"; cat "/sys/fs/cgroup/$file"; done; printf "[status]\\n"; cat /proc/1/status';

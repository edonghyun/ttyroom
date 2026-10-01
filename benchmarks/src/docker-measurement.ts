import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  containerSampleCommand,
  parseContainerSample,
  checkContainerSample,
  type ContainerSample,
} from "./container-observation.js";

export type DockerCommand = (args: string[], label: string, timeout?: number) => Promise<string>;

/** External watchdog: a stalled generator cannot disable sampling, deadlines or stop. */
export async function measureDockerOutput(
  docker: DockerCommand,
  server: string,
  generator: string,
  directory: string,
  timeoutMs: number,
) {
  await mkdir(directory);
  const failures: string[] = [];
  const previous: Partial<Record<"server" | "generator", ContainerSample>> = {};
  const deadline = performance.now() + timeoutMs;
  let released = false;
  let result: { completed: boolean; failures: string[] } | undefined;
  try {
    for (;;) {
      const tick = performance.now();
      if (tick >= deadline) throw new Error("Trial deadline exceeded");
      for (const [role, container] of [
        ["server", server],
        ["generator", generator],
      ] as const) {
        const raw = await docker(
          ["exec", container, "sh", "-c", containerSampleCommand],
          `${role}-sample`,
          2500,
        );
        const sample = parseContainerSample(raw, performance.now());
        const assessment = checkContainerSample(sample, previous[role], role);
        await appendFile(
          resolve(directory, "samples.jsonl"),
          JSON.stringify({
            role,
            at: new Date().toISOString(),
            sample,
            ...assessment,
          }) + "\n",
        );
        if (
          sample.cpuCount !== (role === "server" ? 2 : 1) ||
          sample.memoryLimitBytes !== (role === "server" ? 1024 : 512) * 1024 ** 2
        )
          throw new Error(`${role}: unexpected cgroup limits`);
        if (assessment.failures.length)
          throw new Error(`${role}: ${assessment.failures.join(", ")}`);
        previous[role] = sample;
      }
      const state = await docker(
        [
          "exec",
          generator,
          "sh",
          "-c",
          "if [ -f /tmp/result.json ]; then echo done; elif [ -f /tmp/ready ]; then echo ready; fi",
        ],
        "load-state",
        2500,
      );
      const observedAt = performance.now();
      if (observedAt >= deadline) throw new Error("Trial deadline exceeded");
      if (Object.values(previous).some((sample) => observedAt - sample.atMs > 3000))
        throw new Error("Container observations became stale");
      if (state === "done") {
        if (!released) throw new Error("Load finished before watchdog release");
        const rawResult = await docker(
          ["exec", generator, "cat", "/tmp/result.json"],
          "load-result",
          2500,
        );
        await writeFile(resolve(directory, "load.json"), rawResult + "\n");
        result = JSON.parse(rawResult);
        if (result?.completed !== true || !Array.isArray(result.failures) || result.failures.length)
          throw new Error(`Load failed: ${result?.failures?.join(", ") ?? "invalid result"}`);
        break;
      }
      if (!released && state === "ready") {
        await docker(
          ["exec", generator, "sh", "-c", "echo start > /tmp/start"],
          "release-load",
          2500,
        );
        released = true;
      }
      await delay(Math.max(0, 1000 - (performance.now() - tick)));
    }
  } catch (error) {
    failures.push(String(error));
  }
  // Stop before returning to potentially slow diagnostics, including on sampling failure.
  try {
    await docker(["stop", "--time", "1", generator], "watchdog-stop-load", 5000);
  } catch (error) {
    failures.push(String(error));
  }
  const summary = { completed: !!result?.completed && failures.length === 0, failures, released };
  await writeFile(resolve(directory, "watchdog.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

import { summarizeFlight, type FlightEvent } from "./capacity-report.js";
import { measureDockerOutput } from "./docker-measurement.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const requested = process.argv[2];
const profile = process.argv[3] ?? "smoke";
if (!requested || process.argv.length > 4 || !["smoke", "pilot", "output"].includes(profile))
  throw new Error(
    "Usage: pnpm --filter @ttyroom/benchmarks bench:docker artifacts/new-directory [smoke|pilot|output]",
  );
const directory = resolve(root, requested);
const withinArtifacts = relative(resolve(root, "artifacts"), directory);
if (!withinArtifacts || withinArtifacts.startsWith("..") || isAbsolute(withinArtifacts))
  throw new Error("Docker benchmark evidence must use a new directory under artifacts/");
// Exclusive creation protects old evidence, including failed runs.
await mkdir(resolve(root, "artifacts"), { recursive: true });
await mkdir(directory);
await writeFile(resolve(directory, "compose.env"), "");
const project = `ttyroom-bench-${randomUUID()}`;
const serverImage = `${project}-server`;
const generatorImage = `${project}-generator`;
const env = {
  ...process.env,
  BENCH_SERVER_IMAGE: serverImage,
  BENCH_GENERATOR_IMAGE: generatorImage,
  BENCH_MAX_CONNECTIONS: profile === "smoke" ? "2" : "16",
};
const compose = [
  "compose",
  "--env-file",
  resolve(directory, "compose.env"),
  "--project-name",
  project,
  "--file",
  resolve(root, "benchmarks/docker/compose.yaml"),
];
let sequence = 0;
let activeCommand: AbortController | undefined;
let interrupted = false;
let cleaningUp = false;
const interrupt = () => {
  interrupted = true;
  activeCommand?.abort();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function docker(args: string[], label: string, timeout = 60_000) {
  if (interrupted && !cleaningUp && args[0] !== "stop") throw new Error("Benchmark interrupted");
  const file = resolve(directory, `${++sequence}-${label}.log`);
  try {
    activeCommand = new AbortController();
    const result = await execute("docker", args, {
      cwd: root,
      env,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      signal: activeCommand.signal,
    });
    await writeFile(file, result.stdout + result.stderr);
    return result.stdout.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    await writeFile(file, (failure.stdout ?? "") + (failure.stderr ?? "") + "\n" + failure.message);
    throw new Error(`${label} failed; see ${file}`, { cause: error });
  } finally {
    activeCommand = undefined;
  }
}

let completed = false;
const failures: string[] = [];
try {
  await copyFile(
    resolve(root, "backend/build/libs/ttyroom-backend.jar"),
    resolve(directory, "ttyroom-backend.jar"),
  );
  const git = async (...args: string[]) =>
    (await execute("git", args, { cwd: root })).stdout.trim();
  await writeFile(
    resolve(directory, "manifest.json"),
    JSON.stringify(
      {
        kind: profile === "smoke" ? "isolation-smoke" : "output-ladder",
        profile,
        project,
        startedAt: new Date().toISOString(),
        revision: await git("rev-parse", "HEAD"),
        dirty: (await git("status", "--porcelain")) !== "",
        sourceSha256: Object.fromEntries(
          await Promise.all(
            [
              "benchmarks/src/docker-run.ts",
              "benchmarks/src/docker-smoke.ts",
              "benchmarks/src/docker-load.ts",
              "benchmarks/src/docker-measurement.ts",
              "benchmarks/src/container-observation.ts",
              "benchmarks/src/capacity-peer.ts",
              "benchmarks/src/capacity-traffic.ts",
              "benchmarks/src/capacity-report.ts",
              "benchmarks/docker/compose.yaml",
              "benchmarks/docker/server.Dockerfile",
              "benchmarks/docker/generator.Dockerfile",
              "benchmarks/docker/generator.Dockerfile.dockerignore",
              "pnpm-lock.yaml",
            ].map(async (path) => [
              path,
              createHash("sha256")
                .update(await readFile(resolve(root, path)))
                .digest("hex"),
            ]),
          ),
        ),
        jarSha256: createHash("sha256")
          .update(await readFile(resolve(directory, "ttyroom-backend.jar")))
          .digest("hex"),
        scope:
          "Local Linux container experiment. Pilot is harness verification; no production capacity conclusion.",
      },
      null,
      2,
    ) + "\n",
  );
  await docker(["info", "--format", "{{json .}}"], "docker-environment");
  await docker([...compose, "config"], "resolved-compose");
  await docker(
    [
      "build",
      "--tag",
      serverImage,
      "--file",
      resolve(root, "benchmarks/docker/server.Dockerfile"),
      directory,
    ],
    "build-server",
    600_000,
  );
  await docker(
    [
      "build",
      "--tag",
      generatorImage,
      "--file",
      resolve(root, "benchmarks/docker/generator.Dockerfile"),
      root,
    ],
    "build-generator",
    600_000,
  );
  await docker(
    [
      "image",
      "inspect",
      "--format",
      "{{.Id}} {{.Os}}/{{.Architecture}}",
      serverImage,
      generatorImage,
    ],
    "images",
  );
  await docker(["ps", "--format", "{{.ID}} {{.Names}} {{.Image}}"], "neighbour-containers");
  if (profile !== "smoke") {
    await outputLadder();
  } else {
    await docker([...compose, "up", "--detach", "server"], "start-server");
    await docker(
      [...compose, "run", "--name", `${project}-generator`, "--no-deps", "generator"],
      "smoke",
      90_000,
    );
    const server = await docker([...compose, "ps", "--quiet", "server"], "server-id");
    await verifyIsolation(server, `${project}-generator`);
    await docker(
      [
        ...compose,
        "exec",
        "--no-TTY",
        "server",
        "sh",
        "-c",
        "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/memory.events",
      ],
      "server-cgroup",
    );
    await docker(
      [...compose, "exec", "--no-TTY", "server", "jcmd", "1", "GC.heap_info"],
      "server-heap",
    );
  }
  completed = !interrupted;
} catch (error) {
  failures.push(String(error));
} finally {
  cleaningUp = true;
  try {
    const running = await docker(
      ["ps", "--quiet", "--filter", `name=^/${project}-generator$`],
      "active-load",
    );
    if (running)
      await docker(["stop", "--time", "1", `${project}-generator`], "stop-active-load", 5000);
  } catch (error) {
    failures.push(String(error));
  }
  for (const [args, label] of [
    [[...compose, "logs", "--no-color", "server"], "server-log"],
    [[...compose, "ps", "--all", "--format", "json"], "final-state"],
    [[...compose, "down", "--volumes", "--remove-orphans"], "cleanup"],
  ] as const) {
    try {
      await docker([...args], label);
    } catch (error) {
      failures.push(String(error));
    }
  }
  for (const [resource, args] of [
    ["containers", ["ps", "--all", "--quiet"]],
    ["networks", ["network", "ls", "--quiet"]],
    ["volumes", ["volume", "ls", "--quiet"]],
  ] as const) {
    try {
      const remaining = await docker(
        [...args, "--filter", `label=com.docker.compose.project=${project}`],
        `remaining-${resource}`,
      );
      if (remaining) failures.push(`Benchmark ${resource} remain after cleanup`);
    } catch (error) {
      failures.push(String(error));
    }
  }
  // Only this run's unique tags; no prune or cleanup of other projects.
  try {
    await docker(["image", "rm", serverImage, generatorImage], "remove-images");
  } catch (error) {
    failures.push(String(error));
  }
  const result = { completed: completed && failures.length === 0, failures, directory, project };
  await writeFile(resolve(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  if (!result.completed) process.exitCode = 1;
}

async function outputLadder() {
  const stages: { rate: number; repeat: number; completed: boolean }[] = [];
  const repeats = profile === "pilot" ? 1 : 3;
  const warmup = profile === "pilot" ? 3 : 30;
  const seconds = profile === "pilot" ? 5 : 60;
  for (const rate of [64, 256, 1024]) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const name = `output-${rate}-${repeat}`;
      const trialDirectory = resolve(directory, name);
      console.log(JSON.stringify({ stage: name, status: "starting", warmup, seconds }));
      await docker([...compose, "up", "--detach", "server"], `${name}-start-server`);
      const server = await docker([...compose, "ps", "--quiet", "server"], `${name}-server-id`);
      const generator = `${project}-generator`;
      await docker(
        [
          "exec",
          server,
          "jfr",
          "configure",
          "--input",
          "none",
          "--output",
          "/tmp/load.jfc",
          "+jdk.CPULoad#enabled=true",
          "+jdk.CPULoad#period=1s",
          "+jdk.GarbageCollection#enabled=true",
          "+jdk.GCHeapSummary#enabled=true",
          "+jdk.DataLoss#enabled=true",
          "+ttyroom.ControlQueueWait#enabled=true",
          "+ttyroom.BufferPressure#enabled=true",
        ],
        "jfr-configure",
        15000,
      );
      await docker(
        [
          "exec",
          server,
          "jcmd",
          "1",
          "JFR.start",
          "name=load",
          "settings=/tmp/load.jfc",
          "maxsize=32m",
          "filename=/tmp/load.jfr",
        ],
        "jfr-start",
        15000,
      );
      await docker(
        [
          ...compose,
          "run",
          "--detach",
          "--name",
          generator,
          "--no-deps",
          "generator",
          "benchmarks/src/docker-load.ts",
          String(rate),
          String(warmup),
          String(seconds),
        ],
        `${name}-start-load`,
      );
      await verifyIsolation(server, generator);
      const measurement = await measureDockerOutput(
        docker,
        server,
        generator,
        trialDirectory,
        (warmup + seconds + 65) * 1000,
      );
      // Preserve every failure; unavailable diagnostics must not hide the stop reason.
      const stageFailures = [...measurement.failures];
      cleaningUp = true;
      const diagnostics: (() => Promise<unknown>)[] = [
        () => docker(["logs", generator], `${name}-load-log`),
        () => docker(["inspect", server, generator], `${name}-final-containers`),
        () =>
          docker(["exec", server, "jcmd", "1", "JFR.stop", "name=load"], `${name}-jfr-stop`, 15000),
        async () => {
          // docker cp cannot reliably read tmpfs mounts; stream from the live container.
          const encoded = await docker(
            ["exec", server, "base64", "/tmp/load.jfr"],
            `${name}-jfr-base64`,
            15000,
          );
          await writeFile(resolve(trialDirectory, "load.jfr"), Buffer.from(encoded, "base64"));
        },
        async () => {
          if (!measurement.completed) return;
          const raw = await docker(
            [
              "exec",
              server,
              "jfr",
              "print",
              "--json",
              "--events",
              "jdk.CPULoad,jdk.GarbageCollection,jdk.GCHeapSummary,jdk.DataLoss,ttyroom.ControlQueueWait,ttyroom.BufferPressure",
              "/tmp/load.jfr",
            ],
            `${name}-jfr-events`,
            15000,
          );
          const events = (JSON.parse(raw) as { recording: { events: FlightEvent[] } }).recording
            .events;
          const load = JSON.parse(await readFile(resolve(trialDirectory, "load.json"), "utf8"));
          const flight = summarizeFlight(
            events,
            Date.parse(load.measuredAt.start),
            Date.parse(load.measuredAt.end),
          );
          await writeFile(
            resolve(trialDirectory, "flight.json"),
            JSON.stringify(flight, null, 2) + "\n",
          );
        },
        () => docker(["exec", server, "jcmd", "1", "GC.heap_info"], `${name}-heap`, 15000),
        () => docker([...compose, "logs", "--no-color", "server"], `${name}-server-log`),
        // Every repetition starts with a fresh JVM, DB volume and internal network.
        () => docker([...compose, "down", "--volumes", "--remove-orphans"], `${name}-cleanup`),
      ];
      for (const diagnostic of diagnostics) {
        try {
          await diagnostic();
        } catch (error) {
          stageFailures.push(String(error));
        }
      }
      cleaningUp = false;
      const completed = measurement.completed && !interrupted && stageFailures.length === 0;
      stages.push({ rate, repeat, completed });
      await writeFile(resolve(directory, "stages.json"), JSON.stringify(stages, null, 2) + "\n");
      if (!completed) throw new Error(`${name}: ${stageFailures.join(", ") || "interrupted"}`);
    }
  }
}

async function verifyIsolation(server: string, generator: string) {
  const inspected = JSON.parse(await docker(["inspect", server, generator], "containers"));
  for (const [index, container] of inspected.entries()) {
    const config = container.HostConfig;
    const memory = index === 0 ? 1024 ** 3 : 512 * 1024 ** 2;
    const cpus = index === 0 ? 2 : 1;
    if (
      config.Memory !== memory ||
      config.MemorySwap !== memory ||
      config.NanoCpus !== cpus * 1e9 ||
      !config.ReadonlyRootfs ||
      config.Privileged ||
      Object.keys(config.PortBindings ?? {}).length ||
      container.Mounts.some((mount: { Type: string }) => mount.Type === "bind")
    )
      throw new Error("Actual container isolation differs from the benchmark contract");
  }
}

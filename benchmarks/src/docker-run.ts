import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const requested = process.argv[2];
if (!requested || process.argv.length !== 3)
  throw new Error("Usage: pnpm --filter @ttyroom/benchmarks bench:docker artifacts/new-directory");
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
  if (interrupted && !cleaningUp) throw new Error("Benchmark interrupted");
  const file = resolve(directory, `${++sequence}-${label}.log`);
  try {
    activeCommand = new AbortController();
    const result = await execute("docker", args, {
      cwd: root,
      env,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
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
        kind: "isolation-smoke",
        project,
        startedAt: new Date().toISOString(),
        revision: await git("rev-parse", "HEAD"),
        dirty: (await git("status", "--porcelain")) !== "",
        sourceSha256: Object.fromEntries(
          await Promise.all(
            [
              "benchmarks/src/docker-run.ts",
              "benchmarks/src/docker-smoke.ts",
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
          "Container isolation and admission smoke only; no throughput or capacity conclusion.",
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
  await docker([...compose, "up", "--detach", "server"], "start-server");
  await docker(
    [...compose, "run", "--name", `${project}-generator`, "--no-deps", "generator"],
    "smoke",
    90_000,
  );
  const server = await docker([...compose, "ps", "--quiet", "server"], "server-id");
  const inspected = JSON.parse(
    await docker(["inspect", server, `${project}-generator`], "containers"),
  );
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
  completed = !interrupted;
} catch (error) {
  failures.push(String(error));
} finally {
  cleaningUp = true;
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

#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, printConfig, type ServerConfig } from "./config.js";
import { startServer, type RunningServer } from "./main.js";

export { Room } from "./domain/room.js";
export type { AcquireDecision, ReleaseDecision } from "./domain/room.js";
export { RoomRegistry } from "./domain/room-registry.js";
export { configSchema, loadConfig, printConfig } from "./config.js";
export type { ServerConfig } from "./config.js";
export { startServer } from "./main.js";
export type { RunningServer } from "./main.js";

interface RunCliOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  write?: (text: string) => void;
  start?: (config: ServerConfig) => Promise<RunningServer>;
}

export async function runCli(options: RunCliOptions = {}): Promise<RunningServer | undefined> {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const file = await readConfigFile(cwd);
  const config = loadConfig({ file, env: options.env ?? process.env });
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  if (argv.includes("--print-config")) {
    write(`${printConfig(config)}\n`);
    return undefined;
  }

  const running = await (options.start ?? startServer)(config);
  write(`TTYRoom server listening at ${running.httpBaseUrl}\n`);
  return running;
}

async function readConfigFile(cwd: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, "ttyroom.config.json"), "utf8"));
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`TTYRoom server failed: ${message}\n`);
    process.exitCode = 1;
  });
}

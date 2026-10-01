import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ServerProcess } from "./server-process.js";

afterEach(() => vi.unstubAllEnvs());

it("isolates each server's config and data from developer settings and removes its directory", async () => {
  await using executable = await fakeServer();
  vi.stubEnv("TTYROOM_CONFIG_PATH", "/developer/config.json");
  vi.stubEnv("TTYROOM_STATE_PATH", "/developer/rooms.sqlite");
  vi.stubEnv("TTYROOM_MAX_ROOMS", "999");
  const options = { command: executable.command, capacity: { rooms: 2 } };
  const first = await ServerProcess.start({}, options);
  let firstState: { config: string; state: string; maxRooms?: string };
  try {
    await using second = await ServerProcess.start({}, options);

    firstState = await fetch(first.baseUrl + "/environment").then((r) => r.json());
    const secondState = await fetch(second.baseUrl + "/environment").then((r) => r.json());
    const config = JSON.parse(await readFile(firstState.config, "utf8"));
    await first.restart();
    const restarted = await fetch(first.baseUrl + "/environment").then((r) => r.json());

    expect(firstState.state).not.toBe("/developer/rooms.sqlite");
    expect(firstState.state).not.toBe(secondState.state);
    expect(firstState.config).not.toBe(secondState.config);
    expect(firstState.maxRooms).toBeUndefined();
    expect(config.capacity).toEqual({ rooms: 2 });
    expect(restarted.state).toBe(firstState.state);
  } finally {
    await first.close();
  }
  await expect(stat(firstState!.config)).rejects.toMatchObject({ code: "ENOENT" });
});

async function fakeServer() {
  const directory = await mkdtemp(join(tmpdir(), "ttyroom-support-test-"));
  const script = join(directory, "server.mjs");
  await writeFile(
    script,
    `
    import http from 'node:http';
    const server = http.createServer((request, response) => {
      response.end(request.url === '/healthz' ? 'ok' : JSON.stringify({
        config: process.env.TTYROOM_CONFIG_PATH,
        state: process.env.TTYROOM_STATE_PATH,
        maxRooms: process.env.TTYROOM_MAX_ROOMS,
      }));
    });
    server.listen(Number(process.env.TTYROOM_PORT), '127.0.0.1', () => {
      console.log('TTYRoom server listening at http://127.0.0.1:' + server.address().port);
    });
    process.on('SIGTERM', () => server.close());
  `,
  );
  return {
    command: [process.execPath, script] as const,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

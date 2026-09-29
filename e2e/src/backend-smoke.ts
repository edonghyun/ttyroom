import assert from "node:assert/strict";
import { ServerProcess } from "./server-process.js";

if (!process.env.TTYROOM_E2E_SERVER_COMMAND) {
  throw new Error("Set TTYROOM_E2E_SERVER_COMMAND to the Java executable and built JAR argv");
}

await using server = await ServerProcess.start({}, { startupTimeoutMs: 30_000 });
const originalPid = server.pid;
const originalUrl = server.baseUrl;

await server.restart();
const response = await fetch(`${server.baseUrl}/healthz`);

assert.notEqual(server.pid, originalPid);
assert.equal(server.baseUrl, originalUrl);
assert.equal(response.status, 200);
assert.equal(await response.text(), "ok");
console.log("Backend process smoke passed: readiness, HTTP health, restart, port reuse");

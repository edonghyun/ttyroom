import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile } from "node:fs/promises";
import { waitUntil } from "@ttyroom/test-support/wait-until";
import { CapacityPeer } from "./capacity-peer.js";
import { assess } from "./capacity-report.js";
import { outputTraffic } from "./capacity-traffic.js";

// A single generator owns publisher and observers: latency timestamps share one clock.
// Only this fixed private Compose service can be targeted.
const baseUrl = "http://server:3000";
const [rate, warmupSeconds, seconds] = process.argv.slice(2).map(Number);
if (
  ![64, 256, 1024].includes(rate!) ||
  ![3, 30].includes(warmupSeconds!) ||
  ![5, 60].includes(seconds!)
)
  throw new Error("Use bench:docker pilot or output");
const peers: CapacityPeer[] = [];
const observers: CapacityPeer[] = [];
const failures: string[] = [];
let load: Awaited<ReturnType<typeof outputTraffic>> | undefined;
let measuredAt: { start: string; end: string } | undefined;
try {
  // Hold even the first request until the external watchdog has observed both containers.
  await writeFile("/tmp/ready", "ready");
  await waitUntil(
    async () => {
      try {
        return (await readFile("/tmp/start", "utf8")).trim() === "start";
      } catch {
        return false;
      }
    },
    { timeoutMs: 30_000 },
  );
  await waitUntil(
    async () => {
      try {
        return (await fetch(baseUrl + "/healthz", { signal: AbortSignal.timeout(500) })).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30_000 },
  );
  async function post(path: string, body: object, bearer?: string) {
    const response = await fetch(baseUrl + path, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 201) throw new Error(`Registration failed: ${response.status}`);
    return (await response.json()) as Record<string, string>;
  }
  const room = await post("/api/rooms", {});
  async function connect(credential: string, name: string) {
    const peer = await CapacityPeer.connect(baseUrl, {
      type: "hello",
      protocolVersion: 8,
      roomId: room.roomId,
      credential,
      name,
    });
    peers.push(peer);
    return peer;
  }
  const credential = await post(`/api/rooms/${room.roomId}/hosts`, {}, room.managerCredential);
  const host = await connect(credential.credential!, "Synthetic publisher");
  await host.notice("host-ready", () =>
    host.send({
      type: "host-inventory",
      terminals: [
        {
          terminalId: 1,
          runtimeId: "synthetic-1",
          firstRetainedSeq: 0,
          lastOutputSeq: 0,
        },
      ],
    }),
  );
  for (let i = 0; i < 5; i++) {
    const participant = await post(`/api/rooms/${room.roomId}/participants`, { token: room.token });
    const observer = await connect(participant.credential!, `Observer ${i}`);
    await observer.wait(() => observer.syncs.has(1));
    observer.mode = "live";
    observers.push(observer);
  }
  const sequences = [0];
  const warmup = await outputTraffic(
    { seconds: warmupSeconds!, kibPerSecondPerTerminal: rate! },
    [host],
    observers,
    sequences,
  );
  if (!warmup.completed) throw new Error(`Warmup failed: ${warmup.failure}`);
  observers.forEach((observer) => observer.resetObservations());
  const start = new Date().toISOString();
  load = await outputTraffic(
    { seconds: seconds!, kibPerSecondPerTerminal: rate! },
    [host],
    observers,
    sequences,
  );
  measuredAt = { start, end: new Date().toISOString() };
  failures.push(...assess(load));
  if (load.sentPayloadBytes !== load.plannedPayloadBytes)
    failures.push("target output rate not delivered");
  for (const [index, observer] of observers.entries()) {
    const summary = observer.output.summary();
    if (summary.p95UpperMs === null || summary.p95UpperMs > 100 || summary.maxMs > 1000)
      failures.push(`observer ${index} latency budget`);
  }
} catch (error) {
  failures.push(String(error));
} finally {
  peers.forEach((peer) => peer.close());
  const result = {
    kind: "output-load",
    completed: !!load && failures.length === 0,
    failures,
    scenario: {
      kibPerSecond: rate,
      warmupSeconds,
      seconds,
      terminals: 1,
      hosts: 1,
      observers: 5,
      compression: true,
      payload: "4096 bytes, repeated x plus timestamp/sequence",
    },
    measuredAt,
    observers: observers.map((peer) => ({
      receivedFrames: peer.receivedFrames,
      gaps: peer.gaps,
      sequenceErrors: peer.sequenceErrors,
      output: peer.output.summary(),
    })),
    load,
  };
  // Keep the process alive for the watchdog's final sample and Docker cp, even on failure. The host stops us after copying.
  await writeFile("/tmp/result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ completed: result.completed, failures }));
  await delay(30_000);
  if (!result.completed) process.exitCode = 1;
}

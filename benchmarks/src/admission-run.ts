import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release } from "node:os";
import { ServerProcess } from "@ttyroom/test-support/server-process";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";
import { waitUntil } from "@ttyroom/test-support/wait-until";
import { CapacityPeer } from "./capacity-peer.js";
import { JvmObservation } from "./jvm-observation.js";
import { encodeDataFrame } from "@ttyroom/protocol";

const root = process.env.TTYROOM_CAPACITY_DIR;
const javaHome = process.env.JAVA_HOME;
if (!root || !javaHome) throw new Error("Use measure-capacity.sh with the admission profile");
const directory = resolve(root);
const limits = { rooms: 4, connections: 16, terminals: 16, retainedHistoryBytes: 16_777_216 };

async function trial(repetition: number) {
  const output = resolve(directory, `admission-${repetition}`);
  await mkdir(output);
  await using server = await ServerProcess.start(
    {},
    {
      protocolVersion: 8,
      capacity: limits,
      startupTimeoutMs: 30_000,
      command: [
        resolve(javaHome!, "bin/java"),
        "-Xms256m",
        "-Xmx512m",
        "-XX:+UseG1GC",
        "-jar",
        resolve(directory, "ttyroom-backend.jar"),
      ],
    },
  );
  const observation = new JvmObservation(server.pid!, javaHome!, output);
  const hosts: SocketProbe[] = [];
  const observers: CapacityPeer[] = [];
  const failures: string[] = [];
  const heap = [];
  const recoveries: { round: number; elapsedMs: number; bytes: number }[] = [];
  const closures: number[] = [];
  let flight;
  let recording = false;
  let start = Date.now();
  const rejections: { roomStatus?: number; terminalCode?: string; connectionCode?: number } = {};
  async function post(path: string, body: object, bearer?: string) {
    return fetch(server.baseUrl + path, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  async function issue(path: string, body: object, bearer?: string) {
    const response = await post(path, body, bearer);
    if (response.status !== 201)
      throw new Error(`Unexpected registration status: ${response.status}`);
    return (await response.json()) as Record<string, string>;
  }
  try {
    heap.push(await observation.postGcHeap("empty"));
    await observation.startRecording(resolve(directory, "capacity.jfc"));
    recording = true;
    start = Date.now();
    const rooms: {
      roomId?: string;
      managerCredential?: string;
      hostId: string;
      participants: Record<string, string>[];
    }[] = [];
    for (let i = 0; i < limits.rooms; i++) {
      const room = await issue("/api/rooms", {});
      const host = await issue(`/api/rooms/${room.roomId}/hosts`, {}, room.managerCredential);
      const peer = await SocketProbe.connect(server.baseUrl);
      hosts.push(peer);
      peer.send(hello(room.roomId!, host.credential!));
      requireType(await peer.next(), "welcome");
      peer.send(inventory(4));
      requireType(await peer.next(), "host-ready");
      for (let terminalId = 1; terminalId <= 4; terminalId++) {
        for (let seq = 1; seq <= 256; seq++) {
          const payload = Buffer.alloc(4096, 120);
          payload.writeDoubleBE(performance.now(), 0);
          payload.writeUInt32BE(seq, 8);
          peer.sendBytes(encodeDataFrame({ kind: "output", terminalId, seq, payload }));
        }
      }
      peer.send(inventory(4));
      requireType(await peer.next(), "host-ready");
      const participants = [];
      for (let p = 0; p < 3; p++)
        participants.push(
          await issue(`/api/rooms/${room.roomId}/participants`, { token: room.token }),
        );
      rooms.push({ ...room, hostId: host.hostId!, participants });
    }
    const identities = rooms.flatMap((room) =>
      room.participants.map((p) => hello(room.roomId!, p.credential!)),
    );
    // Every round restores all twelve participants; only four host transports stay connected.
    for (let round = 0; round <= 10; round++) {
      const started = performance.now();
      for (const identity of identities) {
        const peer = await CapacityPeer.connect(server.baseUrl, identity, { mode: "replay" });
        observers.push(peer);
        await peer.wait(() => peer.syncs.size === 4);
        if (peer.receivedBytes !== 4 * 1_048_576 || peer.sequenceErrors || peer.gaps)
          throw new Error("Incomplete or disordered workspace recovery");
      }
      recoveries.push({
        round,
        elapsedMs: performance.now() - started,
        bytes: observers.reduce((sum, peer) => sum + peer.receivedBytes, 0),
      });
      if (round === 0) {
        heap.push(await observation.postGcHeap("full"));
        rejections.roomStatus = (await post("/api/rooms", {})).status;
        hosts[0]!.send(inventory(5));
        const rejected = await hosts[0]!.next();
        rejections.terminalCode = rejected.type === "error" ? rejected.code : rejected.type;
        await using excess = await SocketProbe.connect(server.baseUrl);
        rejections.connectionCode = await excess.closureCode();
      }
      for (const [index, peer] of observers.entries()) peer.probe(999 + index);
      await Promise.all(observers.map((peer) => peer.wait(() => peer.pendingControls.size === 0)));
      if (round === 10) heap.push(await observation.postGcHeap("after-churn"));
      for (const peer of observers) peer.close();
      await Promise.all(observers.map((peer) => waitUntil(() => peer.closed !== undefined)));
      closures.push(...observers.map((peer) => peer.closed!));
      observers.length = 0;
    }
    if (
      rejections.roomStatus !== 503 ||
      rejections.terminalCode !== "capacity-exhausted" ||
      rejections.connectionCode !== 1013
    )
      throw new Error("Admission boundary was not enforced");
    // Revocation removes all four stored terminal entries, then another host can claim them.
    for (const room of rooms) {
      const response = await fetch(
        `${server.baseUrl}/api/rooms/${room.roomId}/hosts/${room.hostId}`,
        {
          method: "DELETE",
          signal: AbortSignal.timeout(5000),
          headers: { Authorization: `Bearer ${room.managerCredential}` },
        },
      );
      if (response.status !== 204) throw new Error("Host release failed");
    }
    for (const peer of hosts) await peer.closed();
    heap.push(await observation.postGcHeap("released"));
    const room = rooms[0]!;
    const host = await issue(`/api/rooms/${room.roomId}/hosts`, {}, room.managerCredential);
    await using replacement = await SocketProbe.connect(server.baseUrl);
    replacement.send(hello(room.roomId!, host.credential!));
    requireType(await replacement.next(), "welcome");
    replacement.send(inventory(16));
    requireType(await replacement.next(), "host-ready");
  } catch (error) {
    failures.push(String(error));
  } finally {
    if (recording) {
      try {
        flight = await observation.recording(start, Date.now());
      } catch (error) {
        failures.push(`JFR: ${String(error)}`);
      }
    }
    await observation.stop();
    if (observation.failures.length) failures.push("RSS sampling failed");
    if (flight?.lostBytes) failures.push("JFR data loss");
    if (observation.samples.some((sample) => sample.serverRssBytes > 768 * 1024 * 1024))
      failures.push("RSS stop line exceeded");
    observers.forEach((peer) => peer.close());
    await Promise.all(hosts.map((peer) => peer[Symbol.asyncDispose]()));
    const result = {
      repetition,
      completed: failures.length === 0,
      failures,
      limits,
      environment: {
        os: `${process.platform} ${release()}`,
        cpu: cpus()[0]?.model,
        node: process.version,
      },
      rejections,
      recoveries,
      closures,
      heap,
      flight,
      rss: observation.samples,
      rssFailures: observation.failures,
    };
    await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
    if (failures.length) await writeFile(resolve(output, "server.log"), server.diagnostics());
    console.log(JSON.stringify({ repetition, completed: result.completed, failures }));
    return result;
  }
}
function hello(roomId: string, credential: string) {
  return { type: "hello", protocolVersion: 8, roomId, credential, name: "Capacity peer" };
}
function inventory(count: number) {
  return {
    type: "host-inventory",
    terminals: Array.from({ length: count }, (_, index) => ({
      terminalId: index + 1,
      runtimeId: `runtime-${index + 1}`,
      firstRetainedSeq: 0,
      lastOutputSeq: 0,
    })),
  };
}
function requireType(message: { type: string }, type: string) {
  if (message.type !== type) throw new Error(`Expected ${type}, received ${message.type}`);
}
const results = [];
for (let repetition = 1; repetition <= 3; repetition++) {
  const result = await trial(repetition);
  results.push(result);
  if (!result.completed) break;
}
await writeFile(resolve(directory, "results.json"), JSON.stringify(results, null, 2) + "\n");
if (results.length !== 3 || results.some((result) => !result.completed)) process.exitCode = 1;

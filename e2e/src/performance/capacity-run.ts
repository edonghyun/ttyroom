import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cpus, release, totalmem } from "node:os";
import { registeredRoom } from "../registered-room.js";
import { waitUntil } from "../wait-until.js";
import { assess } from "./capacity-report.js";
import { CapacityPeer } from "./capacity-peer.js";
import { JvmObservation } from "./jvm-observation.js";

interface Scenario {
  name: string;
  terminals: number;
  hosts: number;
  kibPerSecondPerTerminal: number;
  seconds: number;
  recording: boolean;
  slow?: boolean;
  reconnect?: boolean;
}
const root = process.env.TTYROOM_CAPACITY_DIR;
const javaHome = process.env.JAVA_HOME;
if (!root || !javaHome) throw new Error("Use scripts/measure-capacity.sh with Java 21");
const directory = resolve(root);
const profile = process.env.TTYROOM_CAPACITY_PROFILE ?? "full";
if (!["smoke", "full"].includes(profile)) throw new Error("Unknown capacity profile");

async function trial(scenario: Scenario) {
  const output = resolve(directory, scenario.name);
  await mkdir(output);
  const peers: CapacityPeer[] = [];
  let room: Awaited<ReturnType<typeof registeredRoom>> | undefined;
  let observation: JvmObservation | undefined;
  const failures: string[] = [];
  const heap: Awaited<ReturnType<JvmObservation["postGcHeap"]>>[] = [];
  let flight: Awaited<ReturnType<JvmObservation["recording"]>> | undefined;
  let load: Awaited<ReturnType<typeof traffic>> | undefined;
  let recovery:
    | {
        completed: boolean;
        elapsedMs: number;
        bytes: number;
        expectedBytes: number;
        closures: (number | null)[];
      }
    | undefined;
  let slow: { gaps: number; closeCode: number | null } | undefined;
  let completed = false;
  let startMs = 0;
  let endMs = 0;
  let recordingStarted = false;
  try {
    room = await registeredRoom(8, [
      resolve(javaHome!, "bin/java"),
      "-Xms256m",
      "-Xmx512m",
      "-XX:+UseG1GC",
      "-jar",
      resolve(directory, "ttyroom-backend.jar"),
    ]);
    if (!room.server.pid) throw new Error("Missing server PID");
    observation = new JvmObservation(room.server.pid, javaHome!, output);
    const invitation = room.invitation;
    const hello = (credential: string, name: string) => ({
      type: "hello",
      protocolVersion: 8,
      roomId: invitation.roomId,
      credential,
      name,
    });
    const hosts: { id: string; peer: CapacityPeer }[] = [];
    for (let index = 0; index < scenario.hosts; index++) {
      const credential = await room.host();
      const peer = await CapacityPeer.connect(
        room.server.baseUrl,
        hello(credential.secret, `Synthetic-${index}`),
      );
      peers.push(peer);
      hosts.push({ id: credential.id, peer });
      await peer.notice("host-ready", () =>
        peer.send({
          type: "host-inventory",
          terminals: Array.from({ length: scenario.terminals }, (_, i) => i + 1)
            .filter((id) => (id - 1) % scenario.hosts === index)
            .map((terminalId) => ({
              terminalId,
              runtimeId: `synthetic-${terminalId}`,
              firstRetainedSeq: 0,
              lastOutputSeq: 0,
            })),
        }),
      );
    }
    const observers: CapacityPeer[] = [];
    const credentials: string[] = [];
    for (let i = 0; i < 5; i++) {
      const credential = await room.participant();
      credentials.push(credential.secret);
      const peer = await CapacityPeer.connect(
        room.server.baseUrl,
        hello(credential.secret, `Observer-${i}`),
      );
      peers.push(peer);
      observers.push(peer);
      await peer.wait(() => peer.syncs.size === scenario.terminals);
      peer.mode = "live";
    }
    let slowPeer: CapacityPeer | undefined;
    if (scenario.slow) {
      const credential = await room.participant();
      slowPeer = await CapacityPeer.connect(
        room.server.baseUrl,
        hello(credential.secret, "Paused-consumer"),
      );
      peers.push(slowPeer);
      await slowPeer.wait(() => slowPeer!.syncs.size === scenario.terminals);
      slowPeer.socket.pause();
    }
    if (scenario.recording) {
      await observation.startRecording(resolve(directory, "capacity.jfc"));
      recordingStarted = true;
    }
    heap.push(await observation.postGcHeap("empty"));
    const sequences = new Array<number>(scenario.terminals).fill(0);
    const warmup = await traffic(
      { ...scenario, seconds: 5 },
      hosts.map((h) => h.peer),
      observers,
      sequences,
      observation,
    );
    if (!warmup.completed) throw new Error(`Warmup failed: ${warmup.failure}`);
    observers.forEach((p) => p.resetObservations());
    startMs = Date.now();
    load = await traffic(
      scenario,
      hosts.map((h) => h.peer),
      observers,
      sequences,
      observation,
    );
    endMs = Date.now();
    failures.push(...assess(load));
    heap.push(await observation.postGcHeap("loaded"));

    if (scenario.reconnect) {
      observers.forEach((p) => p.close());
      const started = performance.now();
      const joined = await Promise.allSettled(
        credentials.map(async (credential, i) => {
          const peer = await CapacityPeer.connect(
            room!.server.baseUrl,
            hello(credential, `Rejoined-${i}`),
            "replay",
          );
          peers.push(peer);
          await peer.wait(() => peer.syncs.size === scenario.terminals);
          return peer;
        }),
      );
      const restored = joined.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const bytes = restored.reduce((sum, p) => sum + p.receivedBytes, 0);
      const expectedBytes = scenario.terminals * 1_048_576 * 5;
      recovery = {
        completed: restored.length === 5 && bytes === expectedBytes,
        elapsedMs: performance.now() - started,
        bytes,
        expectedBytes,
        closures: peers.filter((p) => p.mode === "replay").map((p) => p.closed ?? null),
      };
      if (!recovery.completed || recovery.elapsedMs > 5000)
        failures.push("simultaneous replay budget");
    }
    if (slowPeer) {
      slowPeer.socket.resume();
      // Fault duration is intentional; wait for semantic evidence, not an assumed drain time.
      await waitUntil(() => slowPeer.closed !== undefined || slowPeer.gaps > 0, {
        timeoutMs: 6000,
      });
      slow = { gaps: slowPeer.gaps, closeCode: slowPeer.closed ?? null };
    }
    for (const host of hosts) {
      const response = await room.revoke("hosts", host.id);
      if (response.status !== 204) throw new Error("Host cleanup failed");
    }
    // Fixed cooldown is part of the measurement profile, not test synchronization.
    await delay(5000);
    heap.push(await observation.postGcHeap("released"));
    completed = failures.length === 0;
  } catch (error) {
    failures.push(String(error));
  } finally {
    endMs ||= Date.now();
    if (observation && recordingStarted) {
      try {
        flight = await observation.recording(startMs, endMs);
      } catch (error) {
        failures.push(`Recording: ${String(error)}`);
        completed = false;
      }
    }
    await observation?.stop();
    if (observation?.failures.length) {
      failures.push("RSS observation failed");
      completed = false;
    }
    try {
      if (!completed && room)
        await writeFile(resolve(output, "server.log"), room.server.diagnostics());
    } finally {
      peers.forEach((peer) => peer.close());
      try {
        await room?.[Symbol.asyncDispose]();
      } catch (error) {
        failures.push(`Cleanup: ${String(error)}`);
        completed = false;
      }
    }
    const result = {
      scenario,
      completed,
      failures,
      environment: {
        node: process.version,
        os: `${process.platform} ${release()}`,
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
      },
      startMs,
      endMs,
      load,
      heap,
      flight,
      recovery,
      slow,
      rss: observation?.samples ?? [],
      rssFailures: observation?.failures ?? [],
    };
    await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        completed,
        failures,
        outputP95: load?.output.p95UpperMs,
        controlP95: load?.control.p95UpperMs,
      }),
    );
    return result;
  }
}

async function traffic(
  scenario: Scenario,
  hosts: CapacityPeer[],
  observers: CapacityPeer[],
  sequences: number[],
  observation: JvmObservation,
) {
  const base = [...sequences];
  const framesPerSecond = scenario.kibPerSecondPerTerminal / 4;
  const started = performance.now();
  let nextTick = started;
  let nextProbe = started;
  let controlId = 1_000_000;
  let maxScheduleLagMs = 0;
  let completed = false;
  let failure: string | undefined;
  try {
    for (;;) {
      const now = performance.now();
      maxScheduleLagMs = Math.max(maxScheduleLagMs, now - nextTick);
      if (maxScheduleLagMs > 250) throw new Error("Generator schedule lag exceeded 250 ms");
      const latest = observation.samples.at(-1);
      if (
        latest &&
        (latest.serverRssBytes > 768 * 1024 ** 2 || latest.generatorRssBytes > 512 * 1024 ** 2)
      )
        throw new Error("RSS safety budget exceeded");
      if (observation.failures.length) throw new Error("RSS sampling unavailable");
      hosts.forEach((p) => {
        p.check();
        if (p.socket.bufferedAmount > 1024 ** 2)
          throw new Error("Generator socket backlog exceeded 1 MiB");
      });
      observers.forEach((p) => {
        p.check();
        if (p.gaps || p.sequenceErrors || p.output.maxMs > 1000 || p.control.maxMs > 1000)
          throw new Error("Healthy peer exceeded continuity/latency budget");
      });
      const target = Math.floor(
        Math.min(scenario.seconds, (now - started) / 1000) * framesPerSecond,
      );
      for (let i = 0; i < sequences.length; i++)
        while (sequences[i]! < base[i]! + target) {
          hosts[i % hosts.length]!.outputFrame(i + 1, ++sequences[i]!);
        }
      if (now >= nextProbe) {
        observers[0]!.probe(controlId++);
        nextProbe += 100;
      }
      if (now - started >= scenario.seconds * 1000) break;
      nextTick += 10;
      await delay(Math.max(0, nextTick - performance.now()));
    }
    const expected = sequences.reduce((sum, seq, i) => sum + seq - base[i]!, 0);
    await waitUntil(
      () => {
        observers.forEach((p) => p.check());
        return observers.every(
          (p) => p.receivedFrames === expected && p.pendingControls.size === 0,
        );
      },
      { timeoutMs: 5000 },
    );
    completed = true;
  } catch (error) {
    failure = String(error);
  }
  const receivedFrames = observers.reduce((sum, p) => sum + p.receivedFrames, 0);
  const expectedFrames =
    sequences.reduce((sum, seq, i) => sum + seq - base[i]!, 0) * observers.length;
  // Preserve each observer's histogram; combine buckets without storing per-frame samples.
  const output = observers[0]!.output.summary();
  const buckets = output.buckets.map((_, i) =>
    observers.reduce((sum, p) => sum + p.output.buckets[i]!, 0),
  );
  let seen = 0;
  let p95UpperMs: number | null = null;
  for (let i = 0; i <= 1000; i++) {
    seen += buckets[i]!;
    if (receivedFrames && seen >= Math.ceil(receivedFrames * 0.95)) {
      p95UpperMs = i;
      break;
    }
  }
  return {
    completed,
    failure,
    expectedFrames,
    receivedFrames,
    sentPayloadBytes: (expectedFrames / observers.length) * 4096,
    elapsedMs: performance.now() - started,
    maxScheduleLagMs,
    gaps: observers.reduce((s, p) => s + p.gaps, 0),
    sequenceErrors: observers.reduce((s, p) => s + p.sequenceErrors, 0),
    output: {
      ...output,
      count: receivedFrames,
      p95UpperMs,
      maxMs: Math.max(...observers.map((p) => p.output.maxMs)),
      over1000Ms: buckets[1001]!,
      buckets,
    },
    control: observers[0]!.control.summary(),
  };
}

const results: Awaited<ReturnType<typeof trial>>[] = [];
if (profile === "smoke") {
  results.push(
    await trial({
      name: "smoke",
      terminals: 1,
      hosts: 1,
      kibPerSecondPerTerminal: 64,
      seconds: 5,
      recording: true,
    }),
  );
} else {
  const levels = [
    { terminals: 1, hosts: 1, kibPerSecondPerTerminal: 64 },
    { terminals: 1, hosts: 1, kibPerSecondPerTerminal: 256 },
    { terminals: 4, hosts: 1, kibPerSecondPerTerminal: 256 },
    { terminals: 16, hosts: 1, kibPerSecondPerTerminal: 256 },
    { terminals: 16, hosts: 4, kibPerSecondPerTerminal: 1024 },
  ];
  let stopped = false;
  let lastSuccessfulLevel = -1;
  for (let level = 0; level < levels.length && !stopped; level++) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      const result = await trial({
        ...levels[level]!,
        name: `level-${level + 1}-${repeat}`,
        seconds: 20,
        recording: true,
      });
      results.push(result);
      if (!result.completed) {
        stopped = true;
        break;
      }
    }
    if (!stopped) lastSuccessfulLevel = level;
  }
  // Separate faults/calibration never advance an unsuccessful capacity ladder.
  if (lastSuccessfulLevel >= 0) {
    const calibration = levels[Math.min(lastSuccessfulLevel, 1)]!;
    const sustained = levels[Math.min(lastSuccessfulLevel, 3)]!;
    for (let repeat = 1; repeat <= 3; repeat++)
      results.push(
        await trial({
          ...calibration,
          name: `recording-off-${repeat}`,
          seconds: 20,
          recording: false,
        }),
      );
    results.push(await trial({ ...sustained, name: "sustained", seconds: 300, recording: true }));
    results.push(
      await trial({
        ...sustained,
        name: "slow-consumer",
        seconds: 20,
        recording: true,
        slow: true,
      }),
    );
    results.push(
      await trial({
        ...sustained,
        name: "reconnect-burst",
        seconds: 20,
        recording: true,
        reconnect: true,
      }),
    );
  }
}
await writeFile(
  resolve(directory, "index.json"),
  JSON.stringify(
    results.map((r) => ({ name: r.scenario.name, completed: r.completed, failures: r.failures })),
    null,
    2,
  ) + "\n",
);
if (results.some((r) => !r.completed)) process.exitCode = 1;

import { setTimeout as delay } from "node:timers/promises";
import { waitUntil } from "@ttyroom/test-support/wait-until";
import { CapacityPeer } from "./capacity-peer.js";

export async function outputTraffic(
  scenario: { seconds: number; kibPerSecondPerTerminal: number },
  hosts: CapacityPeer[],
  observers: CapacityPeer[],
  sequences: number[],
  assertEnvironmentHealthy: () => void = () => {},
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
      assertEnvironmentHealthy();
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
  const elapsedMs = performance.now() - started;
  const sentPayloadBytes = (expectedFrames / observers.length) * 4096;
  return {
    completed,
    failure,
    expectedFrames,
    receivedFrames,
    plannedPayloadBytes: Math.floor(scenario.seconds * framesPerSecond) * sequences.length * 4096,
    sentPayloadBytes,
    payloadKiBPerSecondIncludingDrain: sentPayloadBytes / 1024 / (elapsedMs / 1000),
    elapsedMs,
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

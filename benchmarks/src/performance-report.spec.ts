import { expect, it } from "vitest";
import { distribution, Timings } from "./performance-report.js";

it("failed operations remain in raw evidence and propagate the original failure", async () => {
  const timings = new Timings();
  const failure = new Error("operation timed out");

  const observed = timings.measure("replay", async () => {
    throw failure;
  });

  await expect(observed).rejects.toBe(failure);
  expect(timings.samples).toEqual([
    {
      operation: "replay",
      startedAtMs: expect.any(Number),
      elapsedMs: expect.any(Number),
      succeeded: false,
    },
  ]);
});

it("reports nearest-rank tails with failed attempts counted separately", () => {
  const samples = [8, 1, 4, 2, 3].map((elapsedMs) => ({
    operation: "input",
    startedAtMs: 0,
    elapsedMs,
    succeeded: true,
  }));
  samples.push({ operation: "input", startedAtMs: 0, elapsedMs: 10_000, succeeded: false });

  const result = distribution(samples);

  expect(result).toEqual({ succeeded: 5, failed: 1, p50Ms: 3, p95Ms: 8, maxMs: 8 });
  expect(samples[0]?.elapsedMs).toBe(8);
});

it("empty measurements have no latency estimate", () => {
  const result = distribution([]);

  expect(result).toEqual({ succeeded: 0, failed: 0, p50Ms: null, p95Ms: null, maxMs: null });
});

import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { Timings, distribution } from "@ttyroom/benchmarks/report";
import { TestSystem } from "../fixtures/test-system.js";
import { ProcessMemory } from "./process-memory.js";
import type { BrowserParticipantActor } from "../fixtures/participant-actor.js";

const profile = process.env.TTYROOM_PERFORMANCE_PROFILE ?? "baseline";
if (!["baseline", "fanout"].includes(profile)) throw new Error("Unknown performance profile");
for (const participants of profile === "fanout" ? [1, 5, 10] : [1]) {
  test(`${participants} participants input and retained-output replay`, async ({
    browser,
  }, info) => {
    const directory = process.env.TTYROOM_PERFORMANCE_DIR;
    if (!directory)
      throw new Error("Use scripts/measure-performance.sh with a new output directory");
    const resultName =
      profile === "baseline"
        ? `browser-${info.repeatEachIndex + 1}`
        : `browser-p${participants}-${info.repeatEachIndex + 1}`;
    const timings = new Timings();
    const observers: BrowserParticipantActor[] = [];
    let system: TestSystem | undefined;
    let memory: ProcessMemory | undefined;
    let alice: BrowserParticipantActor | undefined;
    let completed = false;
    try {
      system = await TestSystem.start();
      memory = new ProcessMemory(system.processIds());
      alice = await system.participant(browser, "Baseline");
      const participant = alice;
      await alice.joinRoom();
      await alice.roomPage.openTerminal();
      await alice.roomPage.takeControl("term-1");
      await alice.roomPage.waitForTerminalStatus("term-1", "You control · Esc to release");

      observers.push(alice);
      for (let i = 1; i < participants; i++) {
        const observer = await system.participant(browser, `Observer-${i}`);
        observers.push(observer);
        await observer.joinRoom();
      }
      const observeAll = (marker: string) =>
        Promise.all(
          observers.map((observer) => observer.roomPage.outputContaining("term-1", marker)),
        );

      for (let i = 0; i < 25; i++) {
        const marker = `MEASURED_OUTPUT_${i}`;
        await timings.measure(i < 5 ? "warmup-input" : "input", async () => {
          await participant.roomPage.printLine("term-1", marker);
          await observeAll(marker);
        });
      }
      await timings.measure("prepare-history", async () => {
        // Printable fixed-width lines; the final contiguous marker never appears in shell echo.
        await participant.roomPage.typeInTerminal(
          "term-1",
          "head -c 524288 /dev/zero | tr '\\0' x | fold -w 128; printf '\\n%s%s\\n' REPLAY_ COMPLETE",
        );
        await observeAll("REPLAY_COMPLETE");
      });
      for (let i = 0; i < 5; i++) {
        await timings.measure("reload-replay", async () => {
          await Promise.all(observers.map((observer) => observer.reloadRoom()));
          await observeAll("REPLAY_COMPLETE");
        });
      }
      observers.forEach((observer) => observer.assertHealthy());
      await memory.stop();

      expect(memory.failures).toEqual([]);
      expect(memory.samples.length).toBeGreaterThan(0);
      expect(
        distribution(timings.samples.filter((sample) => sample.operation === "input")).succeeded,
      ).toBe(20);
      expect(
        distribution(timings.samples.filter((sample) => sample.operation === "reload-replay"))
          .succeeded,
      ).toBe(5);
      completed = true;
    } finally {
      await memory?.stop();
      try {
        try {
          if (!completed && alice) {
            await writeFile(
              resolve(directory, `${resultName}-wire.json`),
              JSON.stringify(
                observers.map((observer) => ({
                  name: observer.nickname,
                  events: JSON.parse(observer.wireDiagnostics()),
                })),
                null,
                2,
              ),
            );
            await writeFile(
              resolve(directory, `${resultName}-process.log`),
              system?.diagnostics() ?? "not started",
            );
          }
        } finally {
          await system?.dispose();
        }
      } catch (error) {
        completed = false;
        throw error;
      } finally {
        await writeFile(
          resolve(directory, `${resultName}.json`),
          JSON.stringify(
            {
              scope: "loopback Spring v8 + SQLite + Connector + zsh PTY + Chromium DOM observation",
              completed,
              profile,
              observation:
                "Input to all participant DOMs; simultaneous reload to all participant DOMs",
              environment: {
                node: process.version,
                chromium: browser.version(),
                os: `${process.platform} ${release()}`,
                cpu: cpus()[0]?.model,
                logicalCpus: cpus().length,
                totalMemoryBytes: totalmem(),
              },
              load: {
                participants,
                connectors: 1,
                terminals: 1,
                warmupInputs: 5,
                measuredInputs: 20,
                historyBytes: 524288,
                reloads: 5,
                rssIntervalMs: 200,
              },
              timings: timings.samples,
              distributions: Object.fromEntries(
                ["input", "reload-replay"].map((operation) => [
                  operation,
                  distribution(timings.samples.filter((sample) => sample.operation === operation)),
                ]),
              ),
              rss: { samples: memory?.samples ?? [], failures: memory?.failures ?? [] },
            },
            null,
            2,
          ) + "\n",
        );
      }
    }
  });
}

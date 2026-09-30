import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { Timings, distribution } from "../../../e2e/src/performance-report.js";
import { TestSystem } from "../fixtures/test-system.js";
import { ProcessMemory } from "./process-memory.js";
import type { BrowserParticipantActor } from "../fixtures/participant-actor.js";

test("single participant input and retained-output replay baseline", async ({ browser }, info) => {
  const directory = process.env.TTYROOM_PERFORMANCE_DIR;
  if (!directory) throw new Error("Use scripts/measure-performance.sh with a new output directory");
  const timings = new Timings();
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

    for (let i = 0; i < 25; i++) {
      const marker = `MEASURED_OUTPUT_${i}`;
      await timings.measure(i < 5 ? "warmup-input" : "input", async () => {
        await participant.roomPage.printLine("term-1", marker);
        await participant.roomPage.outputContaining("term-1", marker);
      });
    }
    await timings.measure("prepare-history", async () => {
      // Printable fixed-width lines; the final contiguous marker never appears in shell echo.
      await participant.roomPage.typeInTerminal(
        "term-1",
        "head -c 524288 /dev/zero | tr '\\0' x | fold -w 128; printf '\\n%s%s\\n' REPLAY_ COMPLETE",
      );
      await participant.roomPage.outputContaining("term-1", "REPLAY_COMPLETE");
    });
    for (let i = 0; i < 5; i++) {
      await timings.measure("reload-replay", async () => {
        await participant.reloadRoom();
        await participant.roomPage.outputContaining("term-1", "REPLAY_COMPLETE");
      });
    }
    alice.assertHealthy();
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
            resolve(directory, `browser-${info.repeatEachIndex + 1}-wire.json`),
            alice.wireDiagnostics(),
          );
          await writeFile(
            resolve(directory, `browser-${info.repeatEachIndex + 1}-process.log`),
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
        resolve(directory, `browser-${info.repeatEachIndex + 1}.json`),
        JSON.stringify(
          {
            scope: "loopback Spring v8 + SQLite + Connector + zsh PTY + Chromium DOM observation",
            completed,
            environment: {
              node: process.version,
              chromium: browser.version(),
              os: `${process.platform} ${release()}`,
              cpu: cpus()[0]?.model,
              logicalCpus: cpus().length,
              totalMemoryBytes: totalmem(),
            },
            load: {
              participants: 1,
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

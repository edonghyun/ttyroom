import { expect, type Browser } from "@playwright/test";
import {
  loadConfig,
  startServer,
  type RunningServer,
  type ServerConfig,
} from "../../../server/dist/index.js";
import { resolve } from "node:path";
import * as pty from "node-pty";
import { BrowserParticipantActor } from "./participant-actor.js";
import { disposeParticipants } from "../../src/test/dispose-participants.js";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");
const WEB_BUILD_ROOT = resolve(WORKSPACE_ROOT, "packages/web/dist");
const MAX_DIAGNOSTIC_CHARS = 16_384;

export interface TestRoom {
  readonly roomId: string;
  readonly name: string;
  readonly token: string;
  readonly joinUrl: string;
}

export interface AgentHandle {
  readonly name: string;
  readonly process: pty.IPty;
  diagnostics(): string;
  toggleKillSwitch(): void;
}

export class TestSystem {
  private readonly actors = new Set<BrowserParticipantActor>();
  private readonly agents = new Set<AgentHandle>();
  private disposed = false;

  private constructor(
    private running: RunningServer,
    private config: ServerConfig,
    readonly room: TestRoom,
  ) {}

  static async start(): Promise<TestSystem> {
    const config = loadConfig({ file: { port: 0, statePath: ":memory:" }, env: {} });
    const running = await startServer(config, { webRoot: WEB_BUILD_ROOT });
    try {
      await expect
        .poll(async () => (await fetch(`${running.httpBaseUrl}/healthz`)).text())
        .toBe("ok");
      const response = await fetch(`${running.httpBaseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Browser Acceptance" }),
      });
      expect(response.status).toBe(201);
      const room = (await response.json()) as TestRoom;
      const system = new TestSystem(running, config, room);
      await system.spawnAgent("real-host");
      return system;
    } catch (error) {
      await running.close();
      throw error;
    }
  }

  async participant(browser: Browser, nickname: string): Promise<BrowserParticipantActor> {
    const actor = await BrowserParticipantActor.create(browser, this.room, nickname);
    this.actors.add(actor);
    return actor;
  }

  toggleKillSwitch(): void {
    const agent = this.agents.values().next().value;
    if (!agent) throw new Error("real agent is not running");
    agent.toggleKillSwitch();
  }

  setOutputDropThreshold(bytes: number): void {
    this.config.policy.sendBufferDropThresholdBytes = bytes;
  }

  async restartWithoutRooms(): Promise<void> {
    const port = this.running.port;
    await this.running.close();
    this.config = loadConfig({
      file: { port, statePath: this.config.statePath, policy: this.config.policy },
      env: {},
    });
    this.running = await startServer(this.config, { webRoot: WEB_BUILD_ROOT });
    await expect
      .poll(async () => (await fetch(`${this.running.httpBaseUrl}/healthz`)).text())
      .toBe("ok");
  }

  private async spawnAgent(name: string): Promise<AgentHandle> {
    let output = "";
    const terminalProcess = pty.spawn(
      process.execPath,
      [
        resolve(WORKSPACE_ROOT, "packages/agent/dist/index.js"),
        "join",
        this.room.joinUrl,
        "--name",
        name,
      ],
      {
        cwd: WORKSPACE_ROOT,
        env: Object.fromEntries(
          Object.entries({ ...process.env, TERM: "xterm-256color" }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        cols: 80,
        rows: 24,
      },
    );
    terminalProcess.onData((chunk) => {
      output = `${output}${chunk}`.slice(-MAX_DIAGNOSTIC_CHARS);
    });
    const handle: AgentHandle = {
      name,
      process: terminalProcess,
      diagnostics: () => output,
      toggleKillSwitch: () => terminalProcess.write("k"),
    };
    this.agents.add(handle);
    try {
      await expect
        .poll(() => handle.diagnostics(), {
          message: `agent did not connect\n${handle.diagnostics()}`,
        })
        .toContain("서버에 연결됨");
      return handle;
    } catch (error) {
      terminalProcess.kill();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    failures.push(...(await disposeParticipants(this.actors)));
    try {
      await this.running.close();
    } catch (error) {
      failures.push(error);
    }
    for (const agent of this.agents) {
      try {
        agent.process.kill();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "TestSystem teardown failed");
  }
}

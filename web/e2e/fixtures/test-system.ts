import { expect, type Browser } from "@playwright/test";
import { ServerProcess } from "../../../e2e/src/server-process.js";
import { resolve } from "node:path";
import * as pty from "node-pty";
import { BrowserParticipantActor } from "./participant-actor.js";
import { disposeParticipants } from "../../src/test/dispose-participants.js";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const MAX_DIAGNOSTIC_CHARS = 16_384;

export interface TestRoom {
  readonly roomId: string;
  readonly name: string;
  readonly token: string;
  readonly joinUrl: string;
}

export interface ConnectorHandle {
  readonly name: string;
  readonly process: pty.IPty;
  diagnostics(): string;
  toggleKillSwitch(): void;
}

export class TestSystem {
  private readonly actors = new Set<BrowserParticipantActor>();
  private readonly connectors = new Set<ConnectorHandle>();
  private disposed = false;

  private constructor(
    private readonly running: ServerProcess,
    readonly room: TestRoom,
  ) {}

  static async start(): Promise<TestSystem> {
    const running = await ServerProcess.start();
    let system: TestSystem | undefined;
    try {
      const response = await fetch(`${running.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Browser Acceptance" }),
      });
      expect(response.status).toBe(201);
      const room = (await response.json()) as TestRoom;
      system = new TestSystem(running, room);
      await system.spawnConnector("real-host");
      return system;
    } catch (error) {
      if (system) await system.dispose();
      else await running.close();
      throw error;
    }
  }

  async participant(browser: Browser, nickname: string): Promise<BrowserParticipantActor> {
    const actor = await BrowserParticipantActor.create(browser, this.room, nickname);
    this.actors.add(actor);
    return actor;
  }

  toggleKillSwitch(): void {
    const connector = this.connectors.values().next().value;
    if (!connector) throw new Error("real connector is not running");
    connector.toggleKillSwitch();
  }

  async restartWithoutRooms(): Promise<void> {
    for (const actor of this.actors) actor.expectServerRestart();
    await this.running.restartWithoutRooms();
  }

  async restart(): Promise<void> {
    for (const actor of this.actors) actor.expectServerRestart();
    await this.running.restart();
  }

  private async spawnConnector(name: string): Promise<ConnectorHandle> {
    let output = "";
    const terminalProcess = pty.spawn(
      process.execPath,
      [
        resolve(WORKSPACE_ROOT, "connector/dist/index.js"),
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
    const handle: ConnectorHandle = {
      name,
      process: terminalProcess,
      diagnostics: () => output,
      toggleKillSwitch: () => terminalProcess.write("k"),
    };
    this.connectors.add(handle);
    try {
      await expect
        .poll(() => handle.diagnostics(), {
          message: `connector did not connect\n${handle.diagnostics()}`,
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
    for (const connector of this.connectors) {
      try {
        connector.process.kill();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "TestSystem teardown failed");
  }
}

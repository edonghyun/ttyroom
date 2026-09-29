import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Owns a direct child, bounded output and escalation on teardown. No shell involved. */
export class TestProcess {
  readonly child: ChildProcess;
  private output = "";
  private spawnError: Error | undefined;
  private readonly completion: Promise<void>;

  constructor(command: readonly [string, ...string[]], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    const append = (chunk: string): void => {
      this.output = (this.output + chunk).slice(-16_384);
    };
    this.child.stdout?.on("data", append);
    this.child.stderr?.on("data", append);
    this.completion = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", (error) => {
        this.spawnError = error;
        resolve();
      });
    });
  }

  exited(): boolean {
    return !!this.spawnError || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  diagnostics(): string {
    return `pid=${this.child.pid ?? "unstarted"} exit=${this.child.exitCode} signal=${this.child.signalCode}\n${this.spawnError?.message ?? ""}\n${this.output}`;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop();
  }

  async stop(): Promise<void> {
    if (this.exited()) return;
    this.child.kill("SIGTERM");
    const controller = new AbortController();
    try {
      await Promise.race([
        this.completion,
        delay(250, undefined, { signal: controller.signal }).then(() => {
          this.child.kill("SIGKILL");
        }),
      ]);
      await this.completion;
    } finally {
      controller.abort();
    }
  }
}

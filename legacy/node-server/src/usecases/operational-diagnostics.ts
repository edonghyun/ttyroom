import { performance } from "node:perf_hooks";
import type { OperationalEvent, TelemetrySink } from "../ports/telemetry.js";

export type ControlCommandOutcome =
  { outcome: "completed" } | { outcome: "rejected"; reason: string };

export type TerminalInputOutcome =
  | { outcome: "forwarded" }
  | {
      outcome: "rejected";
      reason: "terminal-closed" | "remote-input-disabled" | "not-holder";
    };

type ControlContext = Pick<
  Extract<OperationalEvent, { type: "control-command" }>,
  "commandType" | "connectionId" | "roomId" | "role"
>;

type PersistenceContext = Pick<
  Extract<OperationalEvent, { type: "persistence" }>,
  "operation" | "roomId"
>;

type TerminalInputContext = Pick<
  Extract<OperationalEvent, { type: "terminal-input" }>,
  "connectionId" | "roomId" | "terminalId" | "payloadBytes"
>;

type ReplayGapEvent = Extract<OperationalEvent, { type: "replay-gap" }>;

const DISCARD_TELEMETRY: TelemetrySink = { record: () => undefined };

/** Measures operational boundaries and prevents diagnostics failures from affecting room traffic. */
export class OperationalDiagnostics {
  constructor(
    private readonly sink: TelemetrySink = DISCARD_TELEMETRY,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async controlCommand(
    context: ControlContext,
    operation: () => Promise<ControlCommandOutcome>,
  ): Promise<void> {
    const startedAt = this.now();
    try {
      const result = await operation();
      this.emit({
        type: "control-command",
        ...defined(context),
        ...result,
        durationMs: elapsed(this.now(), startedAt),
      });
    } catch (error) {
      this.emit({
        type: "control-command",
        ...defined(context),
        outcome: "failed",
        durationMs: elapsed(this.now(), startedAt),
      });
      throw error;
    }
  }

  async persistence<T>(context: PersistenceContext, operation: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      const result = await operation();
      this.emit({
        type: "persistence",
        ...defined(context),
        outcome: "completed",
        durationMs: elapsed(this.now(), startedAt),
      });
      return result;
    } catch (error) {
      this.emit({
        type: "persistence",
        ...defined(context),
        outcome: "failed",
        durationMs: elapsed(this.now(), startedAt),
      });
      throw error;
    }
  }

  terminalInput(context: TerminalInputContext, route: () => TerminalInputOutcome): void {
    const startedAt = this.now();
    try {
      const result = route();
      this.emit({
        type: "terminal-input",
        ...context,
        ...result,
        durationMs: elapsed(this.now(), startedAt),
      });
    } catch (error) {
      this.emit({
        type: "terminal-input",
        ...context,
        outcome: "failed",
        durationMs: elapsed(this.now(), startedAt),
      });
      throw error;
    }
  }

  replayGap(event: Omit<ReplayGapEvent, "type">): void {
    this.emit({ type: "replay-gap", ...event });
  }

  private emit(event: OperationalEvent): void {
    try {
      this.sink.record(event);
    } catch {
      // Diagnostics must not break the control or terminal data paths.
    }
  }
}

function elapsed(endedAt: number, startedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

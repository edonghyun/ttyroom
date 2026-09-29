import type { OperationalEvent, TelemetrySink } from "../../ports/telemetry.js";

export class JsonLinesTelemetry implements TelemetrySink {
  constructor(private readonly write: (line: string) => void) {}

  record(event: OperationalEvent): void {
    if (isHighVolumeSuccess(event)) return;
    const normalized =
      "durationMs" in event
        ? { ...event, durationMs: Math.round(event.durationMs * 100) / 100 }
        : event;
    this.write(JSON.stringify(normalized));
  }
}

function isHighVolumeSuccess(event: OperationalEvent): boolean {
  return (
    (event.type === "terminal-input" && event.outcome === "forwarded") ||
    (event.type === "control-command" &&
      event.commandType === "move-cursor" &&
      event.outcome === "completed")
  );
}

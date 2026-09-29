import type { OperationalEvent, TelemetrySink } from "../ports/telemetry.js";

export class RecordingTelemetry implements TelemetrySink {
  readonly events: OperationalEvent[] = [];

  record(event: OperationalEvent): void {
    this.events.push(structuredClone(event));
  }

  ofType<Type extends OperationalEvent["type"]>(
    type: Type,
  ): Array<Extract<OperationalEvent, { type: Type }>> {
    return this.events.filter(
      (event): event is Extract<OperationalEvent, { type: Type }> => event.type === type,
    );
  }
}

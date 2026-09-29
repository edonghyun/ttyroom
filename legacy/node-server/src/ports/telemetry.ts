export type OperationalEvent =
  | {
      type: "control-command";
      commandType: string;
      connectionId: string;
      roomId?: string;
      role?: "participant" | "host";
      outcome: "completed" | "rejected" | "failed";
      reason?: string;
      durationMs: number;
    }
  | {
      type: "persistence";
      operation: "load-all" | "save" | "delete" | "close";
      roomId?: string;
      outcome: "completed" | "failed";
      durationMs: number;
    }
  | {
      type: "terminal-input";
      connectionId: string;
      roomId: string;
      terminalId: number;
      payloadBytes: number;
      outcome: "forwarded" | "rejected" | "failed";
      reason?: "terminal-closed" | "remote-input-disabled" | "not-holder";
      durationMs: number;
    }
  | {
      type: "replay-gap";
      phase: "opened" | "recovered";
      connectionId: string;
      roomId: string;
      terminalId: number;
      fromSeq: number;
      toSeq: number;
      droppedFrames: number;
      bufferedBytes: number;
    };

/** Output port for bounded, secret-free operational events. */
export interface TelemetrySink {
  record(event: OperationalEvent): void;
}

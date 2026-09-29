import { describe, expect, it } from "vitest";
import { JsonLinesTelemetry } from "./json-lines-telemetry.js";

describe("JsonLinesTelemetry — 역할: 운영 이벤트의 한 줄 JSON 출력", () => {
  it("duration을 안정적으로 반올림한 JSON 한 줄을 쓴다", () => {
    const lines: string[] = [];
    const telemetry = new JsonLinesTelemetry((line) => lines.push(line));

    telemetry.record({
      type: "terminal-input",
      connectionId: "c1",
      roomId: "r1",
      terminalId: 3,
      payloadBytes: 12,
      outcome: "rejected",
      reason: "not-holder",
      durationMs: 1.236,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "terminal-input",
      connectionId: "c1",
      roomId: "r1",
      terminalId: 3,
      payloadBytes: 12,
      outcome: "rejected",
      reason: "not-holder",
      durationMs: 1.24,
    });
  });

  it("고빈도 성공 input과 cursor는 쓰지 않고 거절은 남긴다", () => {
    const lines: string[] = [];
    const telemetry = new JsonLinesTelemetry((line) => lines.push(line));

    telemetry.record({
      type: "terminal-input",
      connectionId: "c1",
      roomId: "r1",
      terminalId: 3,
      payloadBytes: 2,
      outcome: "forwarded",
      durationMs: 0.1,
    });
    telemetry.record({
      type: "control-command",
      commandType: "move-cursor",
      connectionId: "c1",
      roomId: "r1",
      role: "participant",
      outcome: "completed",
      durationMs: 0.1,
    });
    telemetry.record({
      type: "control-command",
      commandType: "move-cursor",
      connectionId: "c1",
      roomId: "r1",
      role: "host",
      outcome: "rejected",
      reason: "unsupported-for-role",
      durationMs: 0.1,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "control-command",
      outcome: "rejected",
      reason: "unsupported-for-role",
    });
  });
});

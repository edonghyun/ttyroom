import { describe, expect, it } from "vitest";
import { RecordingTelemetry } from "../test/recording-telemetry.js";
import { RoomTestContext } from "../test/room-test-context.js";
import { OperationalDiagnostics } from "./operational-diagnostics.js";

describe("OperationalDiagnostics — 역할: 민감정보 없는 운영 경계 계측", () => {
  it("raw control JSON을 남기지 않고 parse 거절 사유와 처리 시간을 기록한다", async () => {
    const telemetry = new RecordingTelemetry();
    let now = 10;
    const ctx = new RoomTestContext({ telemetry, now: () => (now += 2) });
    const connection = ctx.rawConnection();

    await ctx.core.handleMessage(connection, '{"token":"never-log-this"}');

    expect(telemetry.ofType("control-command")).toEqual([
      {
        type: "control-command",
        commandType: "unparseable",
        connectionId: connection.connectionId,
        outcome: "rejected",
        reason: "bad-message",
        durationMs: 2,
      },
    ]);
    expect(JSON.stringify(telemetry.events)).not.toContain("never-log-this");
  });

  it("계측 sink 실패가 control path 결과를 바꾸지 않는다", async () => {
    const diagnostics = new OperationalDiagnostics({
      record: () => {
        throw new Error("telemetry unavailable");
      },
    });

    await expect(
      diagnostics.controlCommand(
        { commandType: "focus-terminal", connectionId: "c1" },
        async () => ({ outcome: "completed" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("실패한 경계는 failed로 기록하고 원래 오류를 다시 전달한다", async () => {
    const telemetry = new RecordingTelemetry();
    const diagnostics = new OperationalDiagnostics(telemetry, sequenceNow(20, 27));

    await expect(
      diagnostics.persistence({ operation: "save", roomId: "r1" }, async () => {
        throw new Error("save failed");
      }),
    ).rejects.toThrow("save failed");

    expect(telemetry.ofType("persistence")).toEqual([
      {
        type: "persistence",
        operation: "save",
        roomId: "r1",
        outcome: "failed",
        durationMs: 7,
      },
    ]);
  });
});

function sequenceNow(...values: number[]): () => number {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("테스트 시간이 고갈됐다");
    return value;
  };
}

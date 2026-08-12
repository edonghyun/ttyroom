import type { DataFrame, ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { RecordingConnection } from "./recording-connection.js";

const syncMessage = { type: "sync", terminalId: 1, seq: 5 } as ServerMessage;
const outputFrame: DataFrame = {
  kind: "output",
  terminalId: 1,
  seq: 1,
  payload: new Uint8Array([0x68]),
};

describe("RecordingConnection — 역할: 유즈케이스가 보낸 프레임의 기록계", () => {
  it("send·sendData한 메시지와 프레임을 순서대로 기록한다", () => {
    const conn = new RecordingConnection({ connectionId: "c1" });
    conn.send(syncMessage);
    conn.sendData(outputFrame);
    expect(conn.messages).toEqual([syncMessage]);
    expect(conn.dataFrames).toEqual([outputFrame]);
    expect(conn.arrivalOrder).toEqual([
      { kind: "message", message: syncMessage },
      { kind: "data", frame: outputFrame },
    ]);
    expect(conn.connectionId).toBe("c1");
  });

  it("guard가 throw하면 쓰기 전에 막혀 아무것도 기록되지 않는다 (예상 못 한 쓰기 검출용)", () => {
    const conn = new RecordingConnection({
      connectionId: "c1",
      guard: (what) => {
        throw new Error(`예상 못 한 쓰기: ${what}`);
      },
    });

    expect(() => conn.send(syncMessage)).toThrow(/예상 못 한 쓰기: message/);
    expect(() => conn.sendData(outputFrame)).toThrow(/예상 못 한 쓰기: data/);
    expect(conn.messages).toEqual([]);
    expect(conn.dataFrames).toEqual([]);
  });

  it("bufferedBytesValue 설정이 bufferedBytes로 노출되고 close는 closed를 켠다", () => {
    const conn = new RecordingConnection({ connectionId: "c1" });
    conn.bufferedBytesValue = 4096;
    expect(conn.bufferedBytes()).toBe(4096);

    conn.close();
    expect(conn.closed).toBe(true);
  });
});

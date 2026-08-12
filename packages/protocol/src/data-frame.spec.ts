import { describe, expect, it } from "vitest";
import { decodeDataFrame, encodeDataFrame, FRAME_INPUT, FRAME_OUTPUT } from "./data-frame.js";

describe("데이터 프레임 코덱 — 역할: 터미널 입출력 바이트의 유선 표현", () => {
  it("출력 프레임을 인코딩-디코딩 라운드트립하면 동일한 값이 나온다", () => {
    const frame = {
      kind: "output",
      terminalId: 7,
      seq: 42,
      payload: new Uint8Array([104, 105]),
    } as const;
    const decoded = decodeDataFrame(encodeDataFrame(frame));
    expect(decoded).toEqual({ kind: "ok", frame });
  });

  it("입력 프레임 라운드트립은 leaseId를 보존한다", () => {
    const frame = {
      kind: "input",
      terminalId: 1,
      seq: 3,
      leaseId: 9,
      payload: new Uint8Array([108, 115]),
    } as const;
    const decoded = decodeDataFrame(encodeDataFrame(frame));
    expect(decoded).toEqual({ kind: "ok", frame });
  });

  it("출력 프레임 바이트 레이아웃은 PROTOCOL.md 명세와 일치한다", () => {
    // 골든 테스트 — 레이아웃 변경은 프로토콜 버전 범프를 요구한다
    const bytes = encodeDataFrame({
      kind: "output",
      terminalId: 0x0102,
      seq: 1,
      payload: new Uint8Array([0xaa]),
    });
    expect([...bytes]).toEqual([FRAME_OUTPUT, 0, 0, 1, 2, 0, 0, 0, 1, 0xaa]);
  });

  it("입력 프레임 바이트 레이아웃은 seq 다음에 leaseId를 둔다", () => {
    const bytes = encodeDataFrame({
      kind: "input",
      terminalId: 1,
      seq: 2,
      leaseId: 3,
      payload: new Uint8Array(),
    });
    expect([...bytes]).toEqual([FRAME_INPUT, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3]);
  });

  it("알 수 없는 frameType은 malformed 결과를 돌려준다 (throw하지 않는다)", () => {
    expect(decodeDataFrame(new Uint8Array([0xff, 0, 0, 0, 1, 0, 0, 0, 1]))).toMatchObject({
      kind: "malformed",
    });
  });

  it("헤더보다 짧은 바이트열은 malformed 결과를 돌려준다", () => {
    expect(decodeDataFrame(new Uint8Array([FRAME_OUTPUT, 0, 0]))).toMatchObject({
      kind: "malformed",
    });
  });
});

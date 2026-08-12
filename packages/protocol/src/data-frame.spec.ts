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

  it("u32 범위를 벗어나거나 정수가 아닌 필드의 인코딩은 throw한다 (프로그래머 오류)", () => {
    const encode = (fields: { terminalId?: number; seq?: number; leaseId?: number }) => () =>
      encodeDataFrame({
        kind: "input",
        terminalId: 1,
        seq: 1,
        leaseId: 1,
        payload: new Uint8Array(),
        ...fields,
      });
    expect(encode({ terminalId: 0x1_0000_0000 })).toThrow(/terminalId/);
    expect(encode({ seq: -1 })).toThrow(/seq/);
    expect(encode({ seq: 1.5 })).toThrow(/seq/);
    expect(encode({ leaseId: 0x1_0000_0000 })).toThrow(/leaseId/);
  });

  it("byteOffset이 0이 아닌 서브뷰를 디코딩해도 프레임을 올바르게 읽는다", () => {
    // ws는 공유 풀 위의 Buffer 뷰(byteOffset≠0)로 프레임을 전달한다 —
    // bytes.buffer를 offset 없이 읽는 회귀를 여기서 차단한다
    const frame = {
      kind: "output",
      terminalId: 7,
      seq: 42,
      payload: new Uint8Array([1, 2, 3]),
    } as const;
    const encoded = encodeDataFrame(frame);
    const padded = new Uint8Array(4 + encoded.length + 4);
    padded.set(encoded, 4);
    expect(decodeDataFrame(padded.subarray(4, 4 + encoded.length))).toEqual({
      kind: "ok",
      frame,
    });
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

  it("입력 프레임이 입력 헤더(13B)보다 짧으면 malformed 결과를 돌려준다", () => {
    // 특성화 테스트 — 출력 헤더(9B)는 통과하지만 leaseId가 잘린 9~12B 구간
    expect(decodeDataFrame(new Uint8Array([FRAME_INPUT, 0, 0, 0, 1, 0, 0, 0, 2]))).toMatchObject({
      kind: "malformed",
    });
  });
});

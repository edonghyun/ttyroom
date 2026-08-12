export const PROTOCOL_VERSION = 1;
export const FRAME_OUTPUT = 0x01;
export const FRAME_INPUT = 0x02;

// 출력 헤더 9B(type+terminalId+seq), 입력은 leaseId 4B 추가 — PROTOCOL.md와 동기
const OUTPUT_HEADER_BYTES = 9;
const INPUT_HEADER_BYTES = 13;

export interface OutputFrame {
  kind: "output";
  terminalId: number;
  seq: number;
  payload: Uint8Array;
}
export interface InputFrame {
  kind: "input";
  terminalId: number;
  seq: number;
  leaseId: number;
  payload: Uint8Array;
}
export type DataFrame = OutputFrame | InputFrame;
export type DecodeResult = { kind: "ok"; frame: DataFrame } | { kind: "malformed"; reason: string };

export function encodeDataFrame(frame: DataFrame): Uint8Array {
  const headerBytes = frame.kind === "output" ? OUTPUT_HEADER_BYTES : INPUT_HEADER_BYTES;
  const out = new Uint8Array(headerBytes + frame.payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.kind === "output" ? FRAME_OUTPUT : FRAME_INPUT);
  view.setUint32(1, frame.terminalId);
  view.setUint32(5, frame.seq);
  if (frame.kind === "input") view.setUint32(9, frame.leaseId);
  out.set(frame.payload, headerBytes);
  return out;
}

export function decodeDataFrame(bytes: Uint8Array): DecodeResult {
  if (bytes.length < OUTPUT_HEADER_BYTES)
    return { kind: "malformed", reason: "frame shorter than header" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameType = view.getUint8(0);
  const terminalId = view.getUint32(1);
  const seq = view.getUint32(5);
  if (frameType === FRAME_OUTPUT) {
    return {
      kind: "ok",
      frame: { kind: "output", terminalId, seq, payload: bytes.slice(OUTPUT_HEADER_BYTES) },
    };
  }
  if (frameType === FRAME_INPUT) {
    if (bytes.length < INPUT_HEADER_BYTES)
      return { kind: "malformed", reason: "input frame shorter than header" };
    return {
      kind: "ok",
      frame: {
        kind: "input",
        terminalId,
        seq,
        leaseId: view.getUint32(9),
        payload: bytes.slice(INPUT_HEADER_BYTES),
      },
    };
  }
  return { kind: "malformed", reason: `unknown frame type ${frameType}` };
}

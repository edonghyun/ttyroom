import { describe, expect, it } from "vitest";
import { ScrollbackBuffer } from "./scrollback-buffer.js";

describe("ScrollbackBuffer — 역할: 늦은 합류자를 위한 불투명 출력 보관", () => {
  it("append한 프레임을 순서대로 돌려준다", () => {
    const buffer = new ScrollbackBuffer({ maxBytes: 10 });
    buffer.append({
      kind: "output",
      terminalId: 1,
      seq: 1,
      payload: new Uint8Array([1, 2]),
    });
    buffer.append({
      kind: "output",
      terminalId: 1,
      seq: 2,
      payload: new Uint8Array([3]),
    });

    expect(buffer.frames().map((frame) => frame.seq)).toEqual([1, 2]);
  });

  it("maxBytes를 넘으면 오래된 프레임부터 버린다", () => {
    const buffer = new ScrollbackBuffer({ maxBytes: 10 });
    buffer.append({
      kind: "output",
      terminalId: 1,
      seq: 1,
      payload: new Uint8Array(6),
    });
    buffer.append({
      kind: "output",
      terminalId: 1,
      seq: 2,
      payload: new Uint8Array(6),
    });

    expect(buffer.frames().map((frame) => frame.seq)).toEqual([2]);
    expect(buffer.totalBytes()).toBe(6);
  });

  it("lastSeq는 마지막 프레임의 seq이고 비어 있으면 0이다", () => {
    const buffer = new ScrollbackBuffer({ maxBytes: 10 });
    expect(buffer.lastSeq()).toBe(0);

    buffer.append({
      kind: "output",
      terminalId: 1,
      seq: 7,
      payload: new Uint8Array([1]),
    });

    expect(buffer.lastSeq()).toBe(7);
  });
});

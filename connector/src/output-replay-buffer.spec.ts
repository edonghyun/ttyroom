import { describe, expect, it } from "vitest";
import { OutputReplayBuffer } from "./output-replay-buffer.js";

describe("OutputReplayBuffer — 서버 단절 중 bounded PTY 출력 보존", () => {
  it("byte 상한을 넘으면 가장 오래된 frame부터 제거한다", () => {
    const buffer = new OutputReplayBuffer({ maxBytes: 3 });
    buffer.append(frame(1, "ab"));
    buffer.append(frame(2, "cd"));

    expect(buffer.inventory()).toEqual({ firstRetainedSeq: 2, lastOutputSeq: 2 });
    expect(buffer.framesAfter(0).map((item) => item.seq)).toEqual([2]);
  });

  it("서버가 이미 받은 source seq 이후 frame만 복사해 돌려준다", () => {
    const buffer = new OutputReplayBuffer({ maxBytes: 10 });
    buffer.append(frame(1, "a"));
    buffer.append(frame(2, "b"));
    buffer.append(frame(3, "c"));

    const replay = buffer.framesAfter(1);
    replay[0]!.payload[0] = 120;

    expect(replay.map((item) => item.seq)).toEqual([2, 3]);
    expect(new TextDecoder().decode(buffer.framesAfter(1)[0]!.payload)).toBe("b");
  });
});

function frame(seq: number, text: string) {
  return {
    kind: "output" as const,
    terminalId: 3,
    seq,
    payload: new TextEncoder().encode(text),
  };
}

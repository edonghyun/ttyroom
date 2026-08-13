import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./policy.js";

describe("DEFAULT_POLICY — 역할: 스펙 기본값의 단일 진실", () => {
  it("서버의 운영 기본값을 한 객체로 고정한다", () => {
    expect(DEFAULT_POLICY).toEqual({
      participantGraceMs: 15000,
      hostGraceMs: 30000,
      scrollbackBytesPerTerminal: 1048576,
      sendBufferDropThresholdBytes: 1048576,
      maxQueuedDataBytesPerConnection: 1048576,
      outputRateLimitBytesPerSec: 4194304,
    });
  });
});

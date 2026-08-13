import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./ports/policy.js";
import { loadConfig, printConfig } from "./config.js";

describe("loadConfig — 역할: 설정의 검증과 출처 추적", () => {
  it("빈 입력이면 기본값으로 채운다", () => {
    expect(loadConfig({})).toEqual({
      port: 0,
      statePath: ".ttyroom/ttyroom.sqlite",
      policy: DEFAULT_POLICY,
    });
  });

  it("파일 값이 기본값을 덮고 env가 파일 값을 덮는다", () => {
    const config = loadConfig({
      file: { port: 1234, policy: { participantGraceMs: 20_000 } },
      env: { TTYROOM_PORT: "5678", TTYROOM_PARTICIPANT_GRACE_MS: "25000" },
    });

    expect(config.port).toBe(5678);
    expect(config.policy.participantGraceMs).toBe(25_000);
  });

  it("범위를 벗어나거나 숫자가 아닌 설정은 부팅 시점에 throw한다", () => {
    expect(() => loadConfig({ file: { port: -1 } })).toThrow();
    expect(() => loadConfig({ env: { TTYROOM_PORT: "not-a-number" } })).toThrow();
    expect(() => loadConfig({ file: { policy: { outputRateLimitBytesPerSec: 0 } } })).toThrow();
  });

  it("printConfig는 각 최종값과 default/file/env 출처를 표시한다", () => {
    const printed = printConfig(
      loadConfig({
        file: { port: 1234 },
        env: { TTYROOM_PARTICIPANT_GRACE_MS: "25000" },
      }),
    );

    expect(printed).toMatch(/port\s+1234\s+file/);
    expect(printed).toMatch(/statePath\s+\.ttyroom\/ttyroom\.sqlite\s+default/);
    expect(printed).toMatch(/participantGraceMs\s+25000\s+env/);
    expect(printed).toMatch(/hostGraceMs\s+30000\s+default/);
  });

  it("statePath는 파일보다 환경변수를 우선하고 빈 경로는 거부한다", () => {
    expect(
      loadConfig({
        file: { statePath: "file.sqlite" },
        env: { TTYROOM_STATE_PATH: "env.sqlite" },
      }).statePath,
    ).toBe("env.sqlite");
    expect(() => loadConfig({ env: { TTYROOM_STATE_PATH: "" } })).toThrow();
  });

  it("빈 env 숫자 문자열을 0으로 오해하지 않고 잘못된 설정으로 거부한다", () => {
    expect(() => loadConfig({ env: { TTYROOM_PORT: "" } })).toThrow();
  });
});

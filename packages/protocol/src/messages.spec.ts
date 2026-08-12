import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage, serializeServerMessage } from "./messages.js";

describe("제어 메시지 스키마 — 역할: JSON 제어 프레임의 검증과 유선 형태 고정", () => {
  it("정상 hello 메시지를 파싱해 타입을 부여한다", () => {
    const raw = JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      roomId: "r1",
      token: "t",
      clientId: "c1",
      name: "동현",
      role: "participant",
    });
    expect(parseClientMessage(raw)).toMatchObject({
      kind: "ok",
      message: { type: "hello", role: "participant" },
    });
  });

  it("protocolVersion이 1 미만인 hello는 bad-message 결과를 돌려준다", () => {
    const hello = (protocolVersion: number) =>
      JSON.stringify({
        type: "hello",
        protocolVersion,
        roomId: "r1",
        token: "t",
        clientId: "c1",
        name: "동현",
        role: "participant",
      });
    expect(parseClientMessage(hello(0))).toMatchObject({ kind: "bad-message" });
    expect(parseClientMessage(hello(-1))).toMatchObject({ kind: "bad-message" });
  });

  it("알 수 없는 type은 bad-message 결과를 돌려준다", () => {
    expect(parseClientMessage(JSON.stringify({ type: "nope" }))).toMatchObject({
      kind: "bad-message",
    });
  });

  it("JSON이 아닌 입력은 bad-message 결과를 돌려준다 (throw하지 않는다)", () => {
    expect(parseClientMessage("not-json")).toMatchObject({ kind: "bad-message" });
  });

  it("acquire-lease는 terminalId가 음수가 아닌 정수여야 한다", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "acquire-lease", terminalId: -1 })),
    ).toMatchObject({ kind: "bad-message" });
  });

  it("resize-request의 cols·rows는 1..65535 범위를 벗어나면 bad-message 결과를 돌려준다", () => {
    const resize = (cols: number, rows: number) =>
      JSON.stringify({ type: "resize-request", terminalId: 3, cols, rows });
    expect(parseClientMessage(resize(0, 24))).toMatchObject({ kind: "bad-message" });
    expect(parseClientMessage(resize(80, 0x10000))).toMatchObject({ kind: "bad-message" });
    expect(parseClientMessage(resize(80, 24))).toMatchObject({ kind: "ok" });
  });

  it("서버 메시지 직렬화 형태는 골든과 일치한다 — 변경은 PROTOCOL.md 갱신을 요구한다", () => {
    const json = serializeServerMessage({ type: "sync", terminalId: 3, seq: 10 });
    expect(JSON.parse(json)).toEqual({ type: "sync", terminalId: 3, seq: 10 });
  });

  it("parseServerMessage는 JSON이 아니거나 스키마 불일치인 입력에 bad-message를 돌려준다 (throw하지 않는다)", () => {
    // 특성화 테스트 — agent(Rust/Go 재작성 포함)가 의존할 오류 경로 계약을 고정
    expect(parseServerMessage("not-json")).toMatchObject({ kind: "bad-message" });
    expect(parseServerMessage(JSON.stringify({ type: "nope" }))).toMatchObject({
      kind: "bad-message",
    });
  });

  it("서버 메시지를 클라이언트 측에서 파싱할 수 있다 (라운드트립)", () => {
    const msg = {
      type: "lease-result",
      terminalId: 1,
      result: { kind: "granted", leaseId: 5 },
    } as const;
    expect(parseServerMessage(serializeServerMessage(msg))).toEqual({ kind: "ok", message: msg });
  });
});

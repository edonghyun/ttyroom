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

  it("서버 메시지 직렬화 형태는 골든과 일치한다 — 변경은 PROTOCOL.md 갱신을 요구한다", () => {
    const json = serializeServerMessage({ type: "sync", terminalId: 3, seq: 10 });
    expect(JSON.parse(json)).toEqual({ type: "sync", terminalId: 3, seq: 10 });
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

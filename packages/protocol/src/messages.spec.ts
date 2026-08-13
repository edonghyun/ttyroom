import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./data-frame.js";
import {
  parseClientMessage,
  parseServerMessage,
  serializeClientMessage,
  serializeServerMessage,
} from "./messages.js";

describe("제어 메시지 스키마 — 역할: JSON 제어 프레임의 검증과 유선 형태 고정", () => {
  it("shared terminal geometry는 protocol version 4에서 협상한다", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });

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

  it("클라이언트 메시지를 직렬화해 서버 측에서 파싱할 수 있다 (라운드트립)", () => {
    const msg = { type: "acquire-lease", terminalId: 3 } as const;
    expect(parseClientMessage(serializeClientMessage(msg))).toEqual({ kind: "ok", message: msg });
  });

  it("서버 메시지를 클라이언트 측에서 파싱할 수 있다 (라운드트립)", () => {
    const msg = {
      type: "lease-result",
      terminalId: 1,
      result: { kind: "granted", leaseId: 5 },
    } as const;
    expect(parseServerMessage(serializeServerMessage(msg))).toEqual({ kind: "ok", message: msg });
  });

  it("welcome snapshot은 Room 표시 이름을 전달하고 구형 v1 payload에는 안전한 기본값을 채운다", () => {
    const named = parseServerMessage(
      JSON.stringify({
        type: "welcome",
        selfClientId: "c1",
        snapshot: {
          roomId: "r1",
          name: "Payment Debug",
          participants: [],
          hosts: [],
          terminals: [],
          leases: [],
        },
      }),
    );
    const legacy = parseServerMessage(
      JSON.stringify({
        type: "welcome",
        selfClientId: "c1",
        snapshot: { roomId: "r1", participants: [], hosts: [], terminals: [], leases: [] },
      }),
    );

    expect(named).toMatchObject({ kind: "ok", message: { snapshot: { name: "Payment Debug" } } });
    expect(legacy).toMatchObject({ kind: "ok", message: { snapshot: { name: "Quick Room" } } });
  });

  it("participant의 close-terminal-request와 typed rejection을 라운드트립한다", () => {
    const request = { type: "close-terminal-request", terminalId: 3 } as const;
    const rejection = {
      type: "terminal-request-rejected",
      request: "close",
      terminalId: 3,
      reason: "host-offline",
    } as const;

    expect(parseClientMessage(serializeClientMessage(request))).toEqual({
      kind: "ok",
      message: request,
    });
    expect(parseServerMessage(serializeServerMessage(rejection))).toEqual({
      kind: "ok",
      message: rejection,
    });
  });

  it("Host 원격 입력 허용 상태를 구형 snapshot 기본값·보고·event·typed 차단 사유로 표현한다", () => {
    const legacyWelcome = parseServerMessage(
      JSON.stringify({
        type: "welcome",
        selfClientId: "c1",
        snapshot: {
          roomId: "r1",
          participants: [],
          hosts: [{ hostId: "h1", name: "host", online: true }],
          terminals: [],
          leases: [],
        },
      }),
    );
    expect(legacyWelcome).toMatchObject({
      kind: "ok",
      message: { snapshot: { hosts: [{ remoteInputAllowed: true }] } },
    });

    const report = { type: "host-input-state", remoteInputAllowed: false } as const;
    expect(parseClientMessage(serializeClientMessage(report))).toEqual({
      kind: "ok",
      message: report,
    });

    const event = {
      type: "room-event",
      event: { kind: "host-input-state-changed", hostId: "h1", remoteInputAllowed: false },
    } as const;
    expect(parseServerMessage(serializeServerMessage(event))).toEqual({
      kind: "ok",
      message: event,
    });

    const denied = {
      type: "lease-invalid",
      terminalId: 3,
      reason: "remote-input-disabled",
    } as const;
    expect(parseServerMessage(serializeServerMessage(denied))).toEqual({
      kind: "ok",
      message: denied,
    });
  });

  it("participant의 explicit terminal mode 변경과 broadcast event를 라운드트립한다", () => {
    const request = { type: "set-terminal-mode", terminalId: 3, mode: "shared" } as const;
    const changed = {
      type: "room-event",
      event: { kind: "terminal-mode-changed", terminalId: 3, mode: "shared" },
    } as const;

    expect(parseClientMessage(serializeClientMessage(request))).toEqual({
      kind: "ok",
      message: request,
    });
    expect(parseServerMessage(serializeServerMessage(changed))).toEqual({
      kind: "ok",
      message: changed,
    });
  });

  it("output-gap 복구를 위한 terminal 단위 resync-output-request를 라운드트립한다", () => {
    const request = { type: "resync-output-request", terminalId: 3 } as const;

    expect(parseClientMessage(serializeClientMessage(request))).toEqual({
      kind: "ok",
      message: request,
    });
  });

  it("participant의 현재 terminal focus를 snapshot·request·event로 표현한다", () => {
    const welcome = parseServerMessage(
      JSON.stringify({
        type: "welcome",
        selfClientId: "c1",
        snapshot: {
          roomId: "r1",
          participants: [
            { clientId: "c1", name: "동현", focusedTerminalId: 3 },
            { clientId: "c2", name: "수진" },
          ],
          hosts: [],
          terminals: [],
          leases: [],
        },
      }),
    );
    expect(welcome).toMatchObject({
      kind: "ok",
      message: {
        snapshot: {
          participants: [
            { clientId: "c1", focusedTerminalId: 3 },
            { clientId: "c2", focusedTerminalId: null },
          ],
        },
      },
    });

    const request = { type: "focus-terminal", terminalId: 3 } as const;
    const blur = { type: "focus-terminal", terminalId: null } as const;
    const changed = {
      type: "room-event",
      event: { kind: "participant-focus-changed", clientId: "c1", focusedTerminalId: 3 },
    } as const;

    expect(parseClientMessage(serializeClientMessage(request))).toEqual({
      kind: "ok",
      message: request,
    });
    expect(parseClientMessage(serializeClientMessage(blur))).toEqual({ kind: "ok", message: blur });
    expect(parseServerMessage(serializeServerMessage(changed))).toEqual({
      kind: "ok",
      message: changed,
    });
  });

  it("participant의 terminal geometry 갱신과 Room broadcast event를 검증해 라운드트립한다", () => {
    const geometry = { x: -120, y: 48, width: 720, height: 480 };
    const request = { type: "update-terminal-geometry", terminalId: 3, geometry } as const;
    const changed = {
      type: "room-event",
      event: { kind: "terminal-geometry-changed", terminalId: 3, geometry },
    } as const;

    expect(parseClientMessage(JSON.stringify(request))).toEqual({ kind: "ok", message: request });
    expect(parseServerMessage(JSON.stringify(changed))).toEqual({ kind: "ok", message: changed });
    expect(
      parseClientMessage(
        JSON.stringify({
          ...request,
          geometry: { ...geometry, width: 0 },
        }),
      ),
    ).toMatchObject({ kind: "bad-message" });
  });

  it("welcome terminal view는 공유 geometry를 전달하고 구형 payload에는 기본 배치를 채운다", () => {
    const terminal = {
      terminalId: 3,
      hostId: "h1",
      title: "term-3",
      mode: "exclusive",
      status: "open",
      exitCode: null,
      meta: { cwd: null, gitBranch: null, fgProcess: null },
    } as const;
    const welcome = (item: object) =>
      parseServerMessage(
        JSON.stringify({
          type: "welcome",
          selfClientId: "c1",
          snapshot: {
            roomId: "r1",
            participants: [],
            hosts: [],
            terminals: [item],
            leases: [],
          },
        }),
      );

    expect(
      welcome({ ...terminal, geometry: { x: 88, y: 64, width: 720, height: 480 } }),
    ).toMatchObject({
      kind: "ok",
      message: {
        snapshot: {
          terminals: [{ geometry: { x: 88, y: 64, width: 720, height: 480 } }],
        },
      },
    });
    expect(welcome(terminal)).toMatchObject({
      kind: "ok",
      message: {
        snapshot: { terminals: [{ geometry: { x: 24, y: 24, width: 640, height: 420 } }] },
      },
    });
  });
});

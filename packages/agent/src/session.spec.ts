import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type HelloMessage } from "@ttyroom/protocol";
import { AgentSession, type SessionEvent } from "./session.js";
import { FakeAgentTransport } from "./test/fake-agent-transport.js";
import { FakeClock } from "./test/fake-clock.js";

const HELLO: HelloMessage = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  roomId: "room-1",
  token: "token-1",
  clientId: "client-1",
  name: "host-1",
  role: "host",
};

function makeSession() {
  const transport = new FakeAgentTransport();
  const clock = new FakeClock();
  const events: SessionEvent[] = [];
  const session = new AgentSession(
    { transport, clock },
    { wsUrl: "ws://server.test/ws", hello: HELLO, onEvent: (e) => events.push(e) },
  );
  return { transport, clock, session, events };
}

describe("AgentSession — 역할: 서버 연결 수명주기", () => {
  it("start하면 연결 후 hello를 보낸다", async () => {
    const { transport, session } = makeSession();

    session.start();
    await transport.settle();

    expect(transport.lastConnection().sent).toMatchObject([{ type: "hello" }]);
  });

  it("연결이 성립하면 connected 이벤트를 방출한다", async () => {
    const { transport, session, events } = makeSession();

    session.start();
    await transport.settle();

    expect(events).toContainEqual({ kind: "connected" });
  });

  it("연결이 끊기면 지수 백오프(500ms→1s→2s, 상한 10s)로 재접속한다", async () => {
    const { transport, clock, session, events } = makeSession();

    session.start();
    await transport.settle();
    transport.lastConnection().emitClose();
    expect(events).toContainEqual({ kind: "reconnecting", attempt: 1, delayMs: 500 });

    clock.advance(500);
    await transport.settle();
    transport.lastConnection().emitClose();
    expect(events).toContainEqual({ kind: "reconnecting", attempt: 2, delayMs: 1000 });
  });

  it("백오프 지연은 10초를 넘지 않는다", async () => {
    const { transport, clock, session, events } = makeSession();

    session.start();
    await transport.settle();

    // attempt 6의 산술값은 16초 — 상한이 없으면 대기가 계속 배로 늘어난다
    for (const delayMs of [500, 1000, 2000, 4000, 8000, 10_000]) {
      transport.lastConnection().emitClose();
      clock.advance(delayMs);
      await transport.settle();
    }

    expect(events).toContainEqual({ kind: "reconnecting", attempt: 6, delayMs: 10_000 });
  });

  it("welcome을 받으면 attempt가 리셋되어 다음 끊김은 attempt 1부터 시작한다", async () => {
    const { transport, clock, session, events } = makeSession();

    session.start();
    await transport.settle();
    transport.lastConnection().emitClose();
    clock.advance(500);
    await transport.settle();

    transport.lastConnection().emitMessage({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: {
        roomId: "room-1",
        name: "Quick Room",
        hosts: [],
        participants: [],
        terminals: [],
        leases: [],
      },
    });
    transport.lastConnection().emitClose();

    expect(events.filter((e) => e.kind === "reconnecting")).toMatchObject([
      { attempt: 1, delayMs: 500 },
      { attempt: 1, delayMs: 500 },
    ]);
  });

  it("연결 시도가 실패(reject)해도 백오프로 재시도한다", async () => {
    const { transport, clock, session, events } = makeSession();
    transport.failNextConnect();

    session.start();
    await transport.settle();
    expect(events).toContainEqual({ kind: "reconnecting", attempt: 1, delayMs: 500 });

    clock.advance(500);
    await transport.settle();

    expect(transport.lastConnection().sent).toMatchObject([{ type: "hello" }]);
  });

  it("서버 error 메시지를 받으면 재시도 없이 rejected로 끝난다 (버전 불일치 안내)", async () => {
    const { transport, clock, session, events } = makeSession();

    session.start();
    await transport.settle();
    transport.lastConnection().emitMessage({
      type: "error",
      code: "unsupported-protocol-version",
      message: "protocol version 1 required",
    });
    transport.lastConnection().emitClose();
    clock.advance(60_000);
    await transport.settle();

    expect(events).toContainEqual({ kind: "rejected", code: "unsupported-protocol-version" });
    expect(events.filter((e) => e.kind === "reconnecting")).toEqual([]);
    expect(transport.connectUrls).toHaveLength(1);
  });

  it("서버 error 메시지를 받으면 세션이 연결 close를 완결한다", async () => {
    const { transport, session } = makeSession();

    session.start();
    await transport.settle();
    transport.lastConnection().emitMessage({
      type: "error",
      code: "invalid-token",
      message: "token rejected",
    });

    expect(transport.lastConnection().closed).toBe(true);
  });

  it("rejected 이후 수신되는 메시지·데이터는 이벤트로 전달되지 않는다", async () => {
    const { transport, session, events } = makeSession();

    session.start();
    await transport.settle();
    transport.lastConnection().emitMessage({
      type: "error",
      code: "invalid-token",
      message: "token rejected",
    });

    transport.lastConnection().emitMessage({ type: "sync", terminalId: 1, seq: 5 });
    transport
      .lastConnection()
      .emitData({ kind: "input", terminalId: 1, seq: 1, leaseId: 1, payload: new Uint8Array() });

    expect(events.filter((e) => e.kind === "server-message" || e.kind === "server-data")).toEqual(
      [],
    );
  });

  it("stop하면 진행 중 백오프 타이머가 취소된다", async () => {
    const { transport, clock, session } = makeSession();

    session.start();
    await transport.settle();
    transport.lastConnection().emitClose();

    session.stop();
    clock.advance(60_000);
    await transport.settle();

    expect(transport.connectUrls).toHaveLength(1);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("stop하면 활성 연결을 닫고 그 close 이벤트로도 재접속하지 않는다", async () => {
    const { transport, clock, session, events } = makeSession();

    session.start();
    await transport.settle();

    session.stop();
    transport.lastConnection().emitClose();
    clock.advance(60_000);
    await transport.settle();

    expect(transport.lastConnection().closed).toBe(true);
    expect(events.filter((e) => e.kind === "reconnecting")).toEqual([]);
  });

  it("연결된 상태의 send·sendData는 현재 연결로 전달된다", async () => {
    const { transport, session } = makeSession();

    session.start();
    await transport.settle();
    session.send({ type: "terminal-opened", terminalId: 1 });
    session.sendData({ kind: "output", terminalId: 1, seq: 1, payload: new Uint8Array([7]) });

    expect(transport.lastConnection().sent).toMatchObject([
      { type: "hello" },
      { type: "terminal-opened", terminalId: 1 },
    ]);
    expect(transport.lastConnection().sentData).toMatchObject([{ kind: "output", seq: 1 }]);
  });

  it("미연결 상태의 send·sendData는 throw 없이 무시된다", async () => {
    const { transport, clock, session } = makeSession();

    session.start();
    await transport.settle();
    transport.lastConnection().emitClose();

    session.send({ type: "terminal-opened", terminalId: 1 });
    session.sendData({ kind: "output", terminalId: 1, seq: 1, payload: new Uint8Array([7]) });
    clock.advance(500);
    await transport.settle();

    expect(transport.lastConnection().sent).toMatchObject([{ type: "hello" }]);
    expect(transport.lastConnection().sentData).toEqual([]);
  });

  it("서버 제어 메시지는 server-message 이벤트로 전달된다", async () => {
    const { transport, session, events } = makeSession();

    session.start();
    await transport.settle();
    transport
      .lastConnection()
      .emitMessage({ type: "open-terminal", terminalId: 3, cols: 80, rows: 24 });

    expect(events).toContainEqual({
      kind: "server-message",
      message: { type: "open-terminal", terminalId: 3, cols: 80, rows: 24 },
    });
  });

  it("서버 데이터 프레임은 server-data 이벤트로 전달된다", async () => {
    const { transport, session, events } = makeSession();

    session.start();
    await transport.settle();
    const frame = {
      kind: "input",
      terminalId: 3,
      seq: 9,
      leaseId: 2,
      payload: new Uint8Array([104, 105]),
    } as const;
    transport.lastConnection().emitData(frame);

    expect(events).toContainEqual({ kind: "server-data", frame });
  });

  it("onEvent 콜백이 던져도 재접속 타이머는 이미 예약되어 있다 (상태 전이 완결 후 콜백)", async () => {
    const transport = new FakeAgentTransport();
    const clock = new FakeClock();
    const session = new AgentSession(
      { transport, clock },
      {
        wsUrl: "ws://server.test/ws",
        hello: HELLO,
        onEvent: (e) => {
          if (e.kind === "reconnecting") throw new Error("listener bug");
        },
      },
    );

    session.start();
    await transport.settle();

    expect(() => transport.lastConnection().emitClose()).toThrow("listener bug");
    expect(clock.pendingTimerCount()).toBe(1);
  });

  it("stop 이후에 성립한 진행 중 연결 시도는 hello 없이 즉시 닫힌다", async () => {
    const { transport, session, events } = makeSession();

    session.start();
    session.stop();
    await transport.settle();

    expect(transport.lastConnection().closed).toBe(true);
    expect(transport.lastConnection().sent).toEqual([]);
    expect(events).toEqual([]);
  });

  it("stop 이후에 실패(reject)로 끝난 진행 중 연결 시도는 재접속을 예약하지 않는다", async () => {
    const { transport, clock, session, events } = makeSession();
    transport.failNextConnect();

    session.start();
    session.stop();
    await transport.settle();

    expect(events.filter((e) => e.kind === "reconnecting")).toEqual([]);
    expect(clock.pendingTimerCount()).toBe(0);
    expect(transport.connectUrls).toHaveLength(1);
  });

  it("stop 이후의 send·sendData는 닫힌 연결로 전달되지 않는다", async () => {
    const { transport, session } = makeSession();

    session.start();
    await transport.settle();
    session.stop();

    session.send({ type: "terminal-opened", terminalId: 1 });
    session.sendData({ kind: "output", terminalId: 1, seq: 1, payload: new Uint8Array([7]) });

    expect(transport.lastConnection().sent).toMatchObject([{ type: "hello" }]);
    expect(transport.lastConnection().sentData).toEqual([]);
  });

  it("rejected 콜백이 던져도 연결 close는 이미 완결되어 있다", async () => {
    const transport = new FakeAgentTransport();
    const clock = new FakeClock();
    const session = new AgentSession(
      { transport, clock },
      {
        wsUrl: "ws://server.test/ws",
        hello: HELLO,
        onEvent: (e) => {
          if (e.kind === "rejected") throw new Error("listener bug");
        },
      },
    );

    session.start();
    await transport.settle();

    expect(() =>
      transport.lastConnection().emitMessage({
        type: "error",
        code: "invalid-token",
        message: "token rejected",
      }),
    ).toThrow("listener bug");
    expect(transport.lastConnection().closed).toBe(true);
  });

  it("같은 연결의 close 이벤트가 중복 도착해도 재접속은 한 번만 예약된다", async () => {
    const { transport, clock, session, events } = makeSession();

    session.start();
    await transport.settle();

    transport.lastConnection().emitClose();
    transport.lastConnection().emitClose();

    expect(clock.pendingTimerCount()).toBe(1);
    expect(events.filter((e) => e.kind === "reconnecting")).toMatchObject([{ attempt: 1 }]);
  });

  it("이전 연결의 유령 close가 늦게 도착해도 현재 연결을 폐기하지 않는다", async () => {
    const { transport, clock, session } = makeSession();

    session.start();
    await transport.settle();
    const first = transport.lastConnection();
    first.emitClose();
    clock.advance(500);
    await transport.settle();

    first.emitClose();
    session.send({ type: "terminal-opened", terminalId: 1 });

    expect(clock.pendingTimerCount()).toBe(0);
    expect(transport.lastConnection().sent).toMatchObject([
      { type: "hello" },
      { type: "terminal-opened", terminalId: 1 },
    ]);
  });

  it("start를 두 번 호출하면 프로그래머 오류로 throw한다", () => {
    const { session } = makeSession();

    session.start();

    expect(() => session.start()).toThrow();
  });
});

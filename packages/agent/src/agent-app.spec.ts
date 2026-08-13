import { describe, expect, it } from "vitest";
import type { ClientMessage, DataFrame, ServerMessage } from "@ttyroom/protocol";
import { AgentApp } from "./agent-app.js";

class FakeAppSession {
  readonly sent: ClientMessage[] = [];
  readonly sentData: DataFrame[] = [];

  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }

  sendData(frame: DataFrame): void {
    this.sentData.push(frame);
  }
}

class FakeAppPtys {
  readonly opens: Array<{ terminalId: number; cols: number; rows: number }> = [];
  readonly writes: Array<{ terminalId: number; data: Uint8Array }> = [];
  readonly resizes: Array<{ terminalId: number; cols: number; rows: number }> = [];
  readonly closes: number[] = [];
  readonly runtimeIds = new Map<number, string>();
  openError: Error | null = null;

  open(terminalId: number, cols: number, rows: number): string {
    if (this.openError) throw this.openError;
    this.opens.push({ terminalId, cols, rows });
    const runtimeId = this.runtimeIds.get(terminalId) ?? `runtime-${terminalId}`;
    this.runtimeIds.set(terminalId, runtimeId);
    return runtimeId;
  }

  inventory(): Array<{ terminalId: number; runtimeId: string }> {
    return [...this.runtimeIds].map(([terminalId, runtimeId]) => ({ terminalId, runtimeId }));
  }

  write(terminalId: number, data: Uint8Array): void {
    this.writes.push({ terminalId, data });
  }

  resize(terminalId: number, cols: number, rows: number): void {
    this.resizes.push({ terminalId, cols, rows });
  }

  close(terminalId: number): void {
    this.closes.push(terminalId);
  }
}

function makeApp(options: { replayBytes?: number } = {}) {
  const session = new FakeAppSession();
  const ptys = new FakeAppPtys();
  const statusLines: string[] = [];
  const opened: number[] = [];
  const app = new AgentApp(
    { session, ptys },
    {
      onStatus: (line) => statusLines.push(line),
      onTerminalOpened: (terminalId) => opened.push(terminalId),
      outputReplayBytesPerTerminal: options.replayBytes ?? 1024,
    },
  );
  const receive = (message: ServerMessage) => app.handleEvent({ kind: "server-message", message });
  const receiveData = (frame: Extract<DataFrame, { kind: "input" }>) =>
    app.handleEvent({ kind: "server-data", frame });
  const hostIsReady = () => receive({ type: "host-ready", terminals: [] });

  return { app, session, ptys, statusLines, opened, receive, receiveData, hostIsReady };
}

describe("AgentApp — 역할: 서버 명령과 PTY의 배선, Kill Switch", () => {
  it("open-terminal을 받으면 PTY를 열고 terminal-opened를 회신한다", () => {
    const { receive, session, ptys } = makeApp();

    receive({ type: "open-terminal", terminalId: 3, cols: 80, rows: 24 });

    expect(ptys.opens).toEqual([{ terminalId: 3, cols: 80, rows: 24 }]);
    expect(session.sent).toEqual([
      { type: "terminal-opened", terminalId: 3, runtimeId: "runtime-3" },
    ]);
  });

  it("PTY 생성이 실패하면 프로세스를 죽이지 않고 상태와 terminal-closed로 표면화한다", () => {
    const { receive, session, ptys, statusLines, opened } = makeApp();
    ptys.openError = new Error("spawn failed");

    expect(() =>
      receive({ type: "open-terminal", terminalId: 3, cols: 80, rows: 24 }),
    ).not.toThrow();

    expect(session.sent).toEqual([{ type: "terminal-closed", terminalId: 3, exitCode: null }]);
    expect(statusLines).toContain("터미널 3 생성 실패");
    expect(opened).toEqual([]);
  });

  it("close-terminal을 받으면 PTY를 닫되 terminal-closed는 직접 보내지 않는다 (보고는 exit 표면화 한 경로)", () => {
    const { receive, session, ptys } = makeApp();

    receive({ type: "close-terminal", terminalId: 3 });

    expect(ptys.closes).toEqual([3]);
    expect(session.sent).toEqual([]);
  });

  it("resize를 받으면 PTY 크기를 조정한다", () => {
    const { receive, ptys } = makeApp();

    receive({ type: "resize", terminalId: 3, cols: 120, rows: 40 });

    expect(ptys.resizes).toEqual([{ terminalId: 3, cols: 120, rows: 40 }]);
  });

  it("입력 프레임을 받으면 해당 PTY에 쓴다", () => {
    const { hostIsReady, receiveData, ptys } = makeApp();
    const payload = new Uint8Array([108, 115, 10]);
    hostIsReady();

    receiveData({ kind: "input", terminalId: 3, seq: 1, leaseId: 7, payload });

    expect(ptys.writes).toEqual([{ terminalId: 3, data: payload }]);
  });

  it("Kill Switch가 켜져 있으면 입력 프레임을 PTY에 쓰지 않고, 끄면 다시 쓴다", () => {
    const { app, hostIsReady, receiveData, ptys } = makeApp();
    hostIsReady();
    const frame = {
      kind: "input",
      terminalId: 3,
      seq: 1,
      leaseId: 7,
      payload: new Uint8Array([113]),
    } as const;

    app.setKillSwitch(true);
    receiveData(frame);
    expect(ptys.writes).toEqual([]);
    expect(app.killSwitch()).toBe(true);

    app.setKillSwitch(false);
    receiveData(frame);
    expect(ptys.writes).toHaveLength(1);
    expect(app.killSwitch()).toBe(false);
  });

  it("Kill Switch 토글은 onStatus로 상태를 표시한다 (Host Owner가 동작을 확인할 수 있어야 한다)", () => {
    const { app, statusLines } = makeApp();

    app.setKillSwitch(true);
    app.setKillSwitch(false);

    expect(statusLines.some((l) => l.includes("Kill Switch ON"))).toBe(true);
    expect(statusLines.some((l) => l.includes("Kill Switch OFF"))).toBe(true);
  });

  it("reconciliation 완료 뒤와 Kill Switch 토글마다 원격 입력 허용 상태를 보고한다", () => {
    const { app, receive, session } = makeApp();

    app.handleEvent({ kind: "connected" });
    receive({
      type: "welcome",
      selfClientId: "host-1",
      snapshot: {
        roomId: "r",
        name: "Quick Room",
        participants: [],
        hosts: [],
        terminals: [],
        leases: [],
      },
    });
    receive({ type: "host-ready", terminals: [] });
    app.setKillSwitch(true);
    app.setKillSwitch(false);

    expect(session.sent).toEqual([
      { type: "host-inventory", terminals: [] },
      { type: "host-input-state", remoteInputAllowed: true },
      { type: "host-input-state", remoteInputAllowed: false },
      { type: "host-input-state", remoteInputAllowed: true },
    ]);
  });

  it("Kill Switch가 켜져 있으면 open-terminal을 차단하고 terminal-closed로 회신한다 (새 셸 생성 금지)", () => {
    const { app, receive, session, ptys } = makeApp();

    app.setKillSwitch(true);
    receive({ type: "open-terminal", terminalId: 9, cols: 80, rows: 24 });

    expect(ptys.opens).toEqual([]);
    expect(session.sent).toEqual([{ type: "terminal-closed", terminalId: 9, exitCode: null }]);
  });

  it("실제로 연 터미널만 onTerminalOpened로 알린다 — 차단된 open을 관찰자(MetaCollector)가 추적하면 누수다", () => {
    const { app, receive, opened } = makeApp();

    receive({ type: "open-terminal", terminalId: 3, cols: 80, rows: 24 });

    app.setKillSwitch(true);
    receive({ type: "open-terminal", terminalId: 9, cols: 80, rows: 24 });

    expect(opened).toEqual([3]);
  });

  it("Kill Switch가 켜져 있어도 resize·close-terminal은 통과한다 (실행 능력 없음 — 차단하면 상태 드리프트)", () => {
    const { app, receive, ptys } = makeApp();

    app.setKillSwitch(true);
    receive({ type: "resize", terminalId: 3, cols: 100, rows: 30 });
    receive({ type: "close-terminal", terminalId: 3 });

    expect(ptys.resizes).toEqual([{ terminalId: 3, cols: 100, rows: 30 }]);
    expect(ptys.closes).toEqual([3]);
  });

  it("PTY 출력은 터미널별 단조 증가 seq의 출력 프레임으로 session에 전달된다", () => {
    const { app, hostIsReady, session } = makeApp();
    hostIsReady();

    app.handlePtyOutput(3, new Uint8Array([97]));
    app.handlePtyOutput(3, new Uint8Array([98]));
    app.handlePtyOutput(5, new Uint8Array([99]));

    expect(session.sentData).toEqual([
      { kind: "output", terminalId: 3, seq: 1, payload: new Uint8Array([97]) },
      { kind: "output", terminalId: 3, seq: 2, payload: new Uint8Array([98]) },
      { kind: "output", terminalId: 5, seq: 1, payload: new Uint8Array([99]) },
    ]);
  });

  it("exit한 터미널의 seq 상태는 남지 않는다 (장수 프로세스에서 맵이 터미널 수만큼 자라지 않게)", () => {
    const { app, hostIsReady, session } = makeApp();
    hostIsReady();

    app.handlePtyOutput(3, new Uint8Array([97]));
    app.handlePtyExit(3, 0);
    app.handlePtyOutput(3, new Uint8Array([98]));

    expect(session.sentData.map((f) => f.seq)).toEqual([1, 1]);
  });

  it("PTY exit은 terminal-closed 메시지가 된다", () => {
    const { app, session } = makeApp();

    app.handlePtyExit(3, 0);
    app.handlePtyExit(5, null);

    expect(session.sent).toEqual([
      { type: "terminal-closed", terminalId: 3, exitCode: 0 },
      { type: "terminal-closed", terminalId: 5, exitCode: null },
    ]);
  });

  it("welcome을 받으면 실제 PTY와 retained output 범위를 inventory로 보고한다", () => {
    const { app, receive, session, ptys, statusLines } = makeApp();
    ptys.runtimeIds.set(3, "runtime-3");
    app.handlePtyOutput(3, new Uint8Array([97]));

    receive({
      type: "welcome",
      selfClientId: "client-1",
      snapshot: {
        roomId: "r",
        name: "Quick Room",
        participants: [],
        hosts: [],
        terminals: [],
        leases: [],
      },
    });

    expect(ptys.opens).toEqual([]);
    expect(session.sent).toEqual([
      {
        type: "host-inventory",
        terminals: [
          { terminalId: 3, runtimeId: "runtime-3", firstRetainedSeq: 1, lastOutputSeq: 1 },
        ],
      },
    ]);
    expect(session.sentData).toEqual([]);
    expect(statusLines).toEqual([]);
  });

  it("host-ready에서 서버가 받지 못한 bounded 출력만 replay하고 완료를 보고한다", () => {
    const { app, receive, session, ptys } = makeApp({ replayBytes: 2 });
    ptys.runtimeIds.set(3, "runtime-3");
    app.handlePtyOutput(3, new Uint8Array([97]));
    app.handlePtyOutput(3, new Uint8Array([98]));
    app.handlePtyOutput(3, new Uint8Array([99]));

    receive({
      type: "host-ready",
      terminals: [{ terminalId: 3, replayAfterSeq: 0 }],
    });

    expect(session.sentData).toEqual([
      { kind: "output", terminalId: 3, seq: 2, payload: new Uint8Array([98]) },
      { kind: "output", terminalId: 3, seq: 3, payload: new Uint8Array([99]) },
    ]);
    expect(session.sent).toContainEqual({
      type: "terminal-replay-complete",
      terminalId: 3,
      lastOutputSeq: 3,
    });
  });

  it("연결 수명주기 이벤트(connected·reconnecting·rejected)는 onStatus 상태 라인이 된다", () => {
    const { app, statusLines } = makeApp();

    app.handleEvent({ kind: "connected" });
    app.handleEvent({ kind: "reconnecting", attempt: 2, delayMs: 1000 });
    app.handleEvent({ kind: "rejected", code: "invalid-token" });

    expect(statusLines).toHaveLength(3);
    expect(statusLines[1]).toContain("1000ms");
    expect(statusLines[2]).toContain("invalid-token");
  });
});

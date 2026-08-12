import { describe, expect, it } from "vitest";
import type { ClientMessage, DataFrame } from "@ttyroom/protocol";
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

  open(terminalId: number, cols: number, rows: number): void {
    this.opens.push({ terminalId, cols, rows });
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

function makeApp() {
  const session = new FakeAppSession();
  const ptys = new FakeAppPtys();
  const statusLines: string[] = [];
  const app = new AgentApp({ session, ptys }, { onStatus: (line) => statusLines.push(line) });
  return { app, session, ptys, statusLines };
}

describe("AgentApp — 역할: 서버 명령과 PTY의 배선, Kill Switch", () => {
  it("open-terminal을 받으면 PTY를 열고 terminal-opened를 회신한다", () => {
    const { app, session, ptys } = makeApp();

    app.handleEvent({
      kind: "server-message",
      message: { type: "open-terminal", terminalId: 3, cols: 80, rows: 24 },
    });

    expect(ptys.opens).toEqual([{ terminalId: 3, cols: 80, rows: 24 }]);
    expect(session.sent).toEqual([{ type: "terminal-opened", terminalId: 3 }]);
  });

  it("close-terminal을 받으면 PTY를 닫되 terminal-closed는 직접 보내지 않는다 (보고는 exit 표면화 한 경로)", () => {
    const { app, session, ptys } = makeApp();

    app.handleEvent({
      kind: "server-message",
      message: { type: "close-terminal", terminalId: 3 },
    });

    expect(ptys.closes).toEqual([3]);
    expect(session.sent).toEqual([]);
  });

  it("resize를 받으면 PTY 크기를 조정한다", () => {
    const { app, ptys } = makeApp();

    app.handleEvent({
      kind: "server-message",
      message: { type: "resize", terminalId: 3, cols: 120, rows: 40 },
    });

    expect(ptys.resizes).toEqual([{ terminalId: 3, cols: 120, rows: 40 }]);
  });

  it("입력 프레임을 받으면 해당 PTY에 쓴다", () => {
    const { app, ptys } = makeApp();
    const payload = new Uint8Array([108, 115, 10]);

    app.handleEvent({
      kind: "server-data",
      frame: { kind: "input", terminalId: 3, seq: 1, leaseId: 7, payload },
    });

    expect(ptys.writes).toEqual([{ terminalId: 3, data: payload }]);
  });

  it("Kill Switch가 켜져 있으면 입력 프레임을 PTY에 쓰지 않고, 끄면 다시 쓴다", () => {
    const { app, ptys } = makeApp();
    const frame = {
      kind: "input",
      terminalId: 3,
      seq: 1,
      leaseId: 7,
      payload: new Uint8Array([113]),
    } as const;

    app.setKillSwitch(true);
    app.handleEvent({ kind: "server-data", frame });
    expect(ptys.writes).toEqual([]);
    expect(app.killSwitch()).toBe(true);

    app.setKillSwitch(false);
    app.handleEvent({ kind: "server-data", frame });
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

  it("PTY 출력은 터미널별 단조 증가 seq의 출력 프레임으로 session에 전달된다", () => {
    const { app, session } = makeApp();

    app.handlePtyOutput(3, new Uint8Array([97]));
    app.handlePtyOutput(3, new Uint8Array([98]));
    app.handlePtyOutput(5, new Uint8Array([99]));

    expect(session.sentData).toEqual([
      { kind: "output", terminalId: 3, seq: 1, payload: new Uint8Array([97]) },
      { kind: "output", terminalId: 3, seq: 2, payload: new Uint8Array([98]) },
      { kind: "output", terminalId: 5, seq: 1, payload: new Uint8Array([99]) },
    ]);
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

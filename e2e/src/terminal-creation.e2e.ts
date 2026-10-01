import { describe, expect, it } from "vitest";
import {
  protocolRoomFixture,
  protocolWorkspaceFixture as creationFixture,
} from "./protocol-fixture.js";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";

function runtime(terminalId: number, runtimeId = `runtime-${terminalId}`) {
  return { terminalId, runtimeId, firstRetainedSeq: 0, lastOutputSeq: 0 };
}
async function inventory(host: SocketProbe, terminals: ReturnType<typeof runtime>[]) {
  host.send({ type: "host-inventory", terminals });
  const message = await host.next();
  if (message.type !== "host-ready") throw new Error(`Inventory failed: ${message.type}`);
  return message;
}
function requestTerminal(participant: SocketProbe, hostId = "host") {
  participant.send({ type: "open-terminal-request", hostId });
}
async function assignedTerminal(host: SocketProbe) {
  const command = await host.next();
  if (command.type !== "open-terminal")
    throw new Error(`Expected open-terminal, received ${command.type}`);
  return command;
}
function confirmOpened(host: SocketProbe, terminalId: number, runtimeId = `runtime-${terminalId}`) {
  host.send({ type: "terminal-opened", terminalId, runtimeId });
}

describe("Terminal 생성 — Node/Spring 공통", () => {
  it("요청은 기본 크기를 host에 보내고 열린 이벤트는 확인 후 한 번만 보낸다", async () => {
    await using fixture = await creationFixture();

    requestTerminal(fixture.observer);
    const command = await assignedTerminal(fixture.host);
    confirmOpened(fixture.host, command.terminalId);
    confirmOpened(fixture.host, command.terminalId);
    const events = await fixture.captureThroughInputCycle();
    const { welcome } = await fixture.join("late", "participant");

    expect(command).toEqual({ type: "open-terminal", terminalId: 1, cols: 80, rows: 24 });
    expect(events).toMatchObject([
      {
        type: "room-event",
        event: {
          kind: "terminal-opened",
          terminal: {
            terminalId: 1,
            hostId: "host",
            title: "term-1",
            status: "open",
            geometry: { x: 24, y: 24, width: 640, height: 420 },
          },
        },
      },
      { type: "room-event", event: { kind: "host-input-state-changed" } },
    ]);
    expect(welcome.snapshot.terminals).toMatchObject([{ terminalId: 1, status: "open" }]);
  });

  it("확인 전 예약은 snapshot에 보이고 아직 열린 이벤트는 발행하지 않는다", async () => {
    await using fixture = await creationFixture();

    requestTerminal(fixture.observer);
    const command = await assignedTerminal(fixture.host);
    const events = await fixture.captureThroughInputCycle();
    const { welcome } = await fixture.join("late", "participant");

    expect(events).toMatchObject([
      { type: "room-event", event: { kind: "host-input-state-changed" } },
    ]);
    expect(welcome.snapshot.terminals).toMatchObject([
      { terminalId: command.terminalId, status: "open" },
    ]);
  });

  it("확인 전 재접속 inventory는 runtime을 연결하고 다음 생성 ID를 유지한다", async () => {
    await using fixture = await creationFixture();
    requestTerminal(fixture.observer);
    const pending = await assignedTerminal(fixture.host);

    const replacement = (await fixture.join("host", "host")).peer;
    const ready = await inventory(replacement, [runtime(pending.terminalId, "reattached")]);
    requestTerminal(fixture.observer);
    const next = await assignedTerminal(replacement);

    expect(ready.terminals).toEqual([{ terminalId: 1, replayAfterSeq: 0 }]);
    expect(next.terminalId).toBe(2);
  });

  it("복구 ID 뒤에서 여러 참여자의 생성 요청에 서로 다른 ID를 발급한다", async () => {
    await using fixture = await creationFixture([7, 20]);
    const bob = (await fixture.join("bob", "participant")).peer;

    requestTerminal(fixture.observer);
    requestTerminal(bob);
    const commands = [await assignedTerminal(fixture.host), await assignedTerminal(fixture.host)];

    expect(commands.map((command) => command.terminalId)).toEqual([21, 22]);
  });

  it("연결은 있으나 inventory 전인 host에도 기존 계약대로 생성 요청을 전달한다", async () => {
    await using fixture = await protocolRoomFixture();

    requestTerminal(fixture.observer);
    const command = await assignedTerminal(fixture.host);

    expect(command).toMatchObject({ terminalId: 1, cols: 80, rows: 24 });
  });

  it("없는 host와 단절한 host 요청을 거절하며 ID를 소비하지 않는다", async () => {
    await using fixture = await creationFixture();

    requestTerminal(fixture.observer, "missing");
    const missing = await fixture.observer.next();
    await fixture.host.disconnect();
    await fixture.observer.next(); // host-offline is the completed disconnect boundary.
    requestTerminal(fixture.observer);
    const offline = await fixture.observer.next();
    const replacement = (await fixture.join("host", "host")).peer;
    requestTerminal(fixture.observer);
    const command = await assignedTerminal(replacement);

    expect([missing, offline]).toMatchObject([
      { type: "error", code: "bad-message" },
      { type: "error", code: "bad-message" },
    ]);
    expect(command.terminalId).toBe(1);
  });

  it("역할과 소유 host가 다른 생성·확인은 거절하고 정상 확인은 처리한다", async () => {
    await using fixture = await creationFixture();
    const foreign = (await fixture.join("foreign", "host")).peer;
    requestTerminal(fixture.observer);
    const command = await assignedTerminal(fixture.host);

    requestTerminal(fixture.host);
    const wrongRole = await fixture.host.next();
    confirmOpened(fixture.observer, command.terminalId);
    const participant = await fixture.observer.next();
    confirmOpened(foreign, command.terminalId);
    const wrongOwner = await foreign.next();
    confirmOpened(fixture.host, command.terminalId);
    const opened = await fixture.observer.next();

    expect([wrongRole, participant, wrongOwner]).toMatchObject(
      Array.from({ length: 3 }, () => ({ type: "error", code: "bad-message" })),
    );
    expect(opened).toMatchObject({
      event: { kind: "terminal-opened", terminal: { terminalId: 1 } },
    });
  });

  it("inventory에서 누락되어 종료된 예약은 늦은 확인으로 다시 열리지 않는다", async () => {
    await using fixture = await creationFixture();
    requestTerminal(fixture.observer);
    const pending = await assignedTerminal(fixture.host);
    await inventory(fixture.host, []);
    await fixture.observer.next();
    await fixture.observer.next();

    confirmOpened(fixture.host, pending.terminalId);
    const events = await fixture.captureThroughInputCycle();
    requestTerminal(fixture.observer);
    const next = await assignedTerminal(fixture.host);

    expect(events).toMatchObject([{ event: { kind: "host-input-state-changed" } }]);
    expect(next.terminalId).toBe(2);
  });

  it("잘못된 생성·확인을 거절한 뒤 정상 명령을 처리한다", async () => {
    await using fixture = await creationFixture();

    fixture.observer.send({ type: "open-terminal-request", hostId: 7 });
    const request = await fixture.observer.next();
    requestTerminal(fixture.observer);
    const pending = await assignedTerminal(fixture.host);
    confirmOpened(fixture.host, pending.terminalId, "");
    const confirm = await fixture.host.next();
    confirmOpened(fixture.host, pending.terminalId);
    const opened = await fixture.observer.next();

    expect([request, confirm]).toMatchObject([
      { type: "error", code: "bad-message" },
      { type: "error", code: "bad-message" },
    ]);
    expect(opened).toMatchObject({
      event: { kind: "terminal-opened", terminal: { terminalId: 1 } },
    });
  });

  it("다른 방의 host에 요청을 전달하지 않는다", async () => {
    await using fixture = await creationFixture();
    const roomB = await fixture.server.room("B");
    await fixture.join("foreign", "host", roomB);

    requestTerminal(fixture.observer, "foreign");
    const rejection = await fixture.observer.next();
    requestTerminal(fixture.observer);
    const command = await assignedTerminal(fixture.host);

    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
    expect(command.terminalId).toBe(1);
  });

  it.each([
    { type: "open-terminal-request", hostId: "host" },
    { type: "terminal-opened", terminalId: 1, runtimeId: "runtime-1" },
  ])("hello 전에는 $type을 거절한다", async (command) => {
    await using fixture = await creationFixture();
    await using stranger = await SocketProbe.connect(fixture.room.baseUrl);

    stranger.send(command);
    const rejection = await stranger.next();

    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
  });

  it.each([null, 7, 4294967296])(
    "host의 생성 실패·종료 보고(%s)는 예약을 종료하고 중복·늦은 확인을 무시한다",
    async (exitCode) => {
      await using fixture = await creationFixture();
      requestTerminal(fixture.observer);
      const pending = await assignedTerminal(fixture.host);

      fixture.host.send({ type: "terminal-closed", terminalId: pending.terminalId, exitCode });
      fixture.host.send({ type: "terminal-closed", terminalId: pending.terminalId, exitCode });
      confirmOpened(fixture.host, pending.terminalId);
      const events = await fixture.captureThroughInputCycle();
      const { welcome } = await fixture.join("late", "participant");
      requestTerminal(fixture.observer);
      const next = await assignedTerminal(fixture.host);

      expect(events).toMatchObject([
        { event: { kind: "terminal-closed", terminalId: pending.terminalId, exitCode } },
        { event: { kind: "host-input-state-changed" } },
      ]);
      expect(welcome.snapshot.terminals).toMatchObject([
        { terminalId: pending.terminalId, status: "exited", exitCode },
      ]);
      expect(next.terminalId).toBe(2);
    },
  );

  it("uint32 마지막 ID까지 발급하고 소진 뒤에는 상태 변경 없이 요청자에게 거절한다", async () => {
    await using fixture = await creationFixture([0xfffffffe]);

    requestTerminal(fixture.observer);
    const last = await assignedTerminal(fixture.host);
    confirmOpened(fixture.host, last.terminalId);
    await fixture.observer.next();
    requestTerminal(fixture.observer);
    const rejection = await fixture.observer.next();
    const { welcome } = await fixture.join("late", "participant");

    expect(last.terminalId).toBe(0xffffffff);
    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
    expect(welcome.snapshot.terminals.map((terminal) => terminal.terminalId)).toEqual([
      0xfffffffe, 0xffffffff,
    ]);
  });
});

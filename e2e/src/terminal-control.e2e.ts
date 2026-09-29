import { unavailableTerminalStates } from "./terminal-state-fixtures.js";
import { describe, expect, it } from "vitest";
import { protocolRoomFixture, protocolWorkspaceFixture } from "./protocol-fixture.js";
import { inputFixture, sharedInputFixture } from "./protocol-input-fixture.js";
import { controlledTerminalFixture } from "./fixtures.js";
import { SocketProbe } from "./socket-probe.js";
import { printMarker } from "./shell-commands.js";
import { captureOutputReplay } from "./actions.js";

function requestClose(peer: SocketProbe, terminalId = 7) {
  peer.send({ type: "close-terminal-request", terminalId });
}
function requestResize(peer: SocketProbe, terminalId = 7, cols = 120, rows = 40) {
  peer.send({ type: "resize-request", terminalId, cols, rows });
}

/** FIFO reply on the requester's connection proves preceding commands have been processed. */
async function controlBoundary(peer: SocketProbe) {
  peer.send({ type: "acquire-lease", terminalId: 0xfffffffe });
  return peer.next();
}

describe("Terminal 종료·resize — Node/Spring 공통", () => {
  it("종료 요청은 host 보고 전까지 상태와 lease를 유지하며 반복 요청도 전달한다", async () => {
    await using fixture = await inputFixture();

    requestClose(fixture.observer);
    const first = await fixture.host.next();
    requestClose(fixture.observer);
    const repeated = await fixture.host.next();
    const boundary = await controlBoundary(fixture.observer);
    const beforeExit = (await fixture.join("before-exit", "participant")).welcome;
    await fixture.observer.next();
    fixture.host.send({ type: "terminal-closed", terminalId: 7, exitCode: 9 });
    const closed = await fixture.observer.next();
    const afterExit = (await fixture.join("after-exit", "participant")).welcome;

    expect(first).toEqual({ type: "close-terminal", terminalId: 7 });
    expect(repeated).toEqual(first);
    expect(boundary).toMatchObject({ type: "lease-invalid", terminalId: 0xfffffffe });
    expect(beforeExit.snapshot.terminals[0]).toMatchObject({ status: "open" });
    expect(closed).toMatchObject({
      event: { kind: "terminal-closed", terminalId: 7, exitCode: 9 },
    });
    expect(afterExit.snapshot.terminals[0]).toMatchObject({ status: "exited", exitCode: 9 });
    expect(afterExit.snapshot.leases).toEqual(beforeExit.snapshot.leases);
  });

  it.each([
    { mode: "exclusive", given: inputFixture },
    { mode: "shared", given: sharedInputFixture },
  ])(
    "$mode: 제어권 없는 참여자도 Kill Switch 차단 중 close와 resize를 요청한다",
    async ({ given }) => {
      await using fixture = await given();
      const bob = (await fixture.joinParticipant("bob")).peer;
      await fixture.observer.next();
      fixture.host.send({ type: "host-input-state", remoteInputAllowed: false });
      await fixture.observer.next();
      await bob.next();

      requestResize(bob);
      const resize = await fixture.host.next();
      requestClose(bob);
      const close = await fixture.host.next();
      const boundary = await controlBoundary(bob);

      expect(resize).toEqual({ type: "resize", terminalId: 7, cols: 120, rows: 40 });
      expect(close).toEqual({ type: "close-terminal", terminalId: 7 });
      expect(boundary).toMatchObject({ type: "lease-invalid", terminalId: 0xfffffffe });
    },
  );

  it("resize는 u16 경계 치수를 그대로 전달하고 workspace geometry를 바꾸지 않는다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const before = (await fixture.join("before", "participant")).welcome;
    await fixture.observer.next();

    requestResize(fixture.observer, 7, 1, 65535);
    const command = await fixture.host.next();
    const boundary = await controlBoundary(fixture.observer);
    const after = (await fixture.join("after", "participant")).welcome;

    expect(command).toEqual({ type: "resize", terminalId: 7, cols: 1, rows: 65535 });
    expect(boundary).toMatchObject({ type: "lease-invalid" });
    expect(after.snapshot.terminals).toEqual(before.snapshot.terminals);
  });

  it.each([
    { state: "pending", given: pendingTerminalFixture },
    { state: "replacement", given: replacementTerminalFixture },
  ])("$state host도 inventory 이전 close·resize를 받는다", async ({ given }) => {
    await using fixture = await given();
    const { host, terminalId } = fixture;

    requestResize(fixture.observer, terminalId);
    const resize = await host.next();
    requestClose(fixture.observer, terminalId);
    const close = await host.next();

    expect(resize).toMatchObject({ type: "resize", terminalId: terminalId });
    expect(close).toEqual({ type: "close-terminal", terminalId: terminalId });
  });

  it.each(unavailableTerminalStates)(
    "$name 대상을 close는 $reason로, resize는 bad-message로 거절한다",
    async (state) => {
      await using fixture = await protocolWorkspaceFixture([7]);
      await state.prepare(fixture);
      const { terminalId, reason } = state;

      requestClose(fixture.observer, terminalId);
      const close = await fixture.observer.next();
      requestResize(fixture.observer, terminalId);
      const resize = await fixture.observer.next();

      expect(close).toEqual({
        type: "terminal-request-rejected",
        request: "close",
        terminalId,
        reason,
      });
      expect(resize).toMatchObject({ type: "error", code: "bad-message" });
    },
  );

  it("잘못된 치수·ID와 host 역할의 요청 뒤에도 정상 resize를 전달한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    requestClose(fixture.host);
    const roleClose = await fixture.host.next();
    requestResize(fixture.host);
    const roleResize = await fixture.host.next();
    requestResize(fixture.observer, 7, 0, 24);
    const zero = await fixture.observer.next();
    requestResize(fixture.observer, 7, 80, 65536);
    const overflow = await fixture.observer.next();
    requestClose(fixture.observer, -1);
    const id = await fixture.observer.next();
    requestResize(fixture.observer);
    const valid = await fixture.host.next();

    expect([roleClose, roleResize, zero, overflow, id]).toMatchObject(
      Array.from({ length: 5 }, () => ({ type: "error", code: "bad-message" })),
    );
    expect(valid).toMatchObject({ type: "resize", cols: 120, rows: 40 });
  });

  it.each(["close-terminal-request", "resize-request"])("hello 전 %s를 거절한다", async (type) => {
    await using fixture = await protocolRoomFixture();
    await using stranger = await SocketProbe.connect(fixture.room.baseUrl);

    stranger.send({ type, terminalId: 7, cols: 80, rows: 24 });
    const rejected = await stranger.next();

    expect(rejected).toMatchObject({ type: "error", code: "bad-message" });
  });

  it("각 terminal 명령을 소유 host에만 전달한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const other = (await fixture.join("other", "host")).peer;
    other.send({
      type: "host-inventory",
      terminals: [{ terminalId: 8, runtimeId: "runtime-8", firstRetainedSeq: 0, lastOutputSeq: 0 }],
    });
    await other.next();
    await fixture.observer.next();
    await fixture.observer.next();

    requestResize(fixture.observer, 7);
    requestClose(fixture.observer, 8);
    const firstHost = await fixture.host.next();
    const secondHost = await other.next();

    expect(firstHost).toEqual({ type: "resize", terminalId: 7, cols: 120, rows: 40 });
    expect(secondHost).toEqual({ type: "close-terminal", terminalId: 8 });
  });

  it("다른 방에만 존재하는 terminal을 제어할 수 없다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const roomB = await fixture.server.room("B");
    const hostB = (await fixture.join("host", "host", roomB)).peer;
    hostB.send({
      type: "host-inventory",
      terminals: [
        { terminalId: 99, runtimeId: "runtime-99", firstRetainedSeq: 0, lastOutputSeq: 0 },
      ],
    });
    await hostB.next();

    requestClose(fixture.observer, 99);
    const close = await fixture.observer.next();
    requestResize(fixture.observer, 99);
    const resize = await fixture.observer.next();

    expect(close).toMatchObject({
      type: "terminal-request-rejected",
      request: "close",
      reason: "terminal-not-found",
    });
    expect(resize).toMatchObject({ type: "error", code: "bad-message" });
  });

  it("실제 PTY 크기 변경을 셸에서 확인하고 host 종료 보고까지 완료한다", async () => {
    await using fixture = await controlledTerminalFixture(["alice", "watcher"]);
    const { alice, watcher } = fixture.participants;

    alice.requestResize(fixture.terminalId, 101, 37);
    alice.sendInput(fixture.terminalId, "stty size\n" + printMarker("size-checked"));
    const output = await captureOutputReplay(watcher, fixture.terminalId, "size-checked");
    await watcher.closeTerminal(fixture.terminalId);

    expect(output).toContain("37 101");
    expect(watcher.terminal(fixture.terminalId)?.status).toBe("exited");
  });
});

async function pendingTerminalFixture() {
  const fixture = await protocolRoomFixture();
  try {
    fixture.observer.send({ type: "open-terminal-request", hostId: "host" });
    const opened = await fixture.host.next();
    if (opened.type !== "open-terminal") throw new Error("Reservation required");
    return { ...fixture, terminalId: opened.terminalId };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

async function replacementTerminalFixture() {
  const fixture = await pendingTerminalFixture();
  try {
    const host = (await fixture.join("host", "host")).peer;
    return { ...fixture, host };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

import { describe, expect, it } from "vitest";
import { encodeDataFrame, type OutputFrame } from "@ttyroom/protocol";
import {
  protocolRoomFixture as recoveryFixture,
  protocolWorkspaceFixture,
} from "./protocol-fixture.js";
import { SocketProbe, type ProbePacket } from "./socket-probe.js";

function runtime(terminalId: number, runtimeId = `runtime-${terminalId}`, lastOutputSeq = 0) {
  return { terminalId, runtimeId, firstRetainedSeq: 0, lastOutputSeq };
}

async function reportInventory(host: SocketProbe, terminals: ReturnType<typeof runtime>[]) {
  host.send({ type: "host-inventory", terminals });
  const closes: number[] = [];
  for (;;) {
    const message = await host.next();
    if (message.type === "host-ready") return { ready: message, closes };
    if (message.type !== "close-terminal") throw new Error(`Inventory failed: ${message.type}`);
    closes.push(message.terminalId);
  }
}

function output(host: SocketProbe, terminalId: number, seq: number, text: string) {
  host.sendBytes(encodeDataFrame({ kind: "output", terminalId, seq, payload: Buffer.from(text) }));
}
function completeReplay(host: SocketProbe, terminalId: number, lastOutputSeq: number) {
  host.send({ type: "terminal-replay-complete", terminalId, lastOutputSeq });
}
async function captureUntilSync(peer: SocketProbe, terminalId: number) {
  const packets: ProbePacket[] = [];
  for (;;) {
    const packet = await peer.nextPacket();
    packets.push(packet);
    if (
      packet.kind === "control" &&
      packet.message.type === "sync" &&
      packet.message.terminalId === terminalId
    )
      return packets;
  }
}
function expectOutput(packets: ProbePacket[], expected: Array<[number, number, string]>) {
  const frames = packets.filter(
    (packet): packet is { kind: "binary"; frame: OutputFrame } =>
      packet.kind === "binary" && packet.frame.kind === "output",
  );
  expect(
    frames.map(({ frame }) => [frame.terminalId, frame.seq, Buffer.from(frame.payload).toString()]),
  ).toEqual(expected);
}

describe("Terminal inventory/replay — Node/Spring 공통", () => {
  it("Connector-only PTY를 복구하되 inventory의 lastOutputSeq를 수신 완료로 취급하지 않는다", async () => {
    await using fixture = await recoveryFixture();

    const result = await reportInventory(fixture.host, [runtime(7, "runtime-7", 999)]);
    const events = [await fixture.observer.next(), await fixture.observer.next()];
    const { welcome } = await fixture.join("late", "participant");

    expect(result).toEqual({
      closes: [],
      ready: { type: "host-ready", terminals: [{ terminalId: 7, replayAfterSeq: 0 }] },
    });
    expect(events).toMatchObject([
      { type: "room-event", event: { kind: "host-connected" } },
      {
        type: "room-event",
        event: {
          kind: "terminal-opened",
          terminal: {
            terminalId: 7,
            hostId: "host",
            title: "term-7",
            mode: "exclusive",
            status: "open",
            exitCode: null,
            geometry: { x: 216, y: 216, width: 640, height: 420 },
            meta: { cwd: null, gitBranch: null, fgProcess: null },
          },
        },
      },
    ]);
    expect(welcome.snapshot.terminals).toMatchObject([{ terminalId: 7, status: "open" }]);
  });

  it("큰 terminalId를 복구해도 이벤트와 snapshot의 좌표가 프로토콜 범위를 지킨다", async () => {
    await using fixture = await recoveryFixture();

    const result = await reportInventory(fixture.host, [runtime(2049), runtime(0xffffffff)]);
    const events = [
      await fixture.observer.next(),
      await fixture.observer.next(),
      await fixture.observer.next(),
    ];
    const { welcome } = await fixture.join("late", "participant");

    expect(result.ready.terminals.map((terminal) => terminal.terminalId)).toEqual([
      2049, 0xffffffff,
    ]);
    expect(events).toMatchObject([
      { type: "room-event", event: { kind: "host-connected" } },
      {
        type: "room-event",
        event: {
          kind: "terminal-opened",
          terminal: { terminalId: 2049, geometry: { x: 65535, y: 65535 } },
        },
      },
      {
        type: "room-event",
        event: {
          kind: "terminal-opened",
          terminal: { terminalId: 0xffffffff, geometry: { x: 65535, y: 65535 } },
        },
      },
    ]);
    expect(welcome.snapshot.terminals.map((terminal) => terminal.terminalId)).toEqual([
      2049, 0xffffffff,
    ]);
  });

  it("runtime 충돌·누락은 종료하고 새 PTY는 복구하며 close-terminal이 ready보다 먼저 온다", async () => {
    await using fixture = await protocolWorkspaceFixture([7, 8]);

    const result = await reportInventory(fixture.host, [runtime(7, "conflict"), runtime(9)]);
    const events = [
      await fixture.observer.next(),
      await fixture.observer.next(),
      await fixture.observer.next(),
      await fixture.observer.next(),
    ];
    const { welcome } = await fixture.join("late", "participant");

    expect(result).toEqual({
      closes: [7],
      ready: { type: "host-ready", terminals: [{ terminalId: 9, replayAfterSeq: 0 }] },
    });
    expect(events).toMatchObject([
      { event: { kind: "host-connected" } },
      { event: { kind: "terminal-closed", terminalId: 7, exitCode: null } },
      { event: { kind: "terminal-closed", terminalId: 8, exitCode: null } },
      { event: { kind: "terminal-opened", terminal: { terminalId: 9 } } },
    ]);
    expect(welcome.snapshot.terminals.map((t) => [t.terminalId, t.status])).toEqual([
      [7, "exited"],
      [8, "exited"],
      [9, "open"],
    ]);
  });

  it("다른 host의 terminalId와 이미 종료된 ID를 가져오지 못한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const other = (await fixture.join("other", "host")).peer;

    const collision = await reportInventory(other, [runtime(7)]);
    const missing = await reportInventory(fixture.host, []);
    const exited = await reportInventory(fixture.host, [runtime(7)]);

    expect(collision).toEqual({ closes: [7], ready: { type: "host-ready", terminals: [] } });
    expect(missing).toEqual({ closes: [], ready: { type: "host-ready", terminals: [] } });
    expect(exited).toEqual({ closes: [7], ready: { type: "host-ready", terminals: [] } });
  });

  it("source 중복·역순을 제거하고 재접속 뒤에도 브라우저 sequence를 이어간다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    output(fixture.host, 7, 40, "first");
    output(fixture.host, 7, 40, "duplicate");
    output(fixture.host, 7, 39, "old");
    output(fixture.host, 7, 41, "second");
    completeReplay(fixture.host, 7, 41);
    const first = await captureUntilSync(fixture.observer, 7);
    const replacement = (await fixture.join("host", "host")).peer;
    const ready = await reportInventory(replacement, [runtime(7, "runtime-7", 99)]);
    output(replacement, 7, 41, "replayed");
    output(replacement, 7, 42, "third");
    completeReplay(replacement, 7, 42);
    const second = await captureUntilSync(fixture.observer, 7);

    expectOutput(first, [
      [7, 1, "first"],
      [7, 2, "second"],
    ]);
    expect(first.at(-1)).toEqual({
      kind: "control",
      message: { type: "sync", terminalId: 7, seq: 2 },
    });
    expect(ready.ready.terminals).toEqual([{ terminalId: 7, replayAfterSeq: 41 }]);
    expectOutput(second, [[7, 3, "third"]]);
    expect(second.at(-1)).toEqual({
      kind: "control",
      message: { type: "sync", terminalId: 7, seq: 3 },
    });
  });

  it("늦은 입장과 명시적 resync는 같은 보관 출력을 순서대로 보낸 뒤 sync한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    output(fixture.host, 7, 1, "한글");
    output(fixture.host, 7, 2, "\u0000\u001b[31m");
    completeReplay(fixture.host, 7, 2);
    await captureUntilSync(fixture.observer, 7);

    const late = (await fixture.join("late", "participant")).peer;
    const joined = await captureUntilSync(late, 7);
    late.send({ type: "resync-output-request", terminalId: 7 });
    const replayed = await captureUntilSync(late, 7);

    expectOutput(joined, [
      [7, 1, "한글"],
      [7, 2, "\u0000\u001b[31m"],
    ]);
    expect(replayed).toEqual(joined);
    expect(joined.at(-1)).toEqual({
      kind: "control",
      message: { type: "sync", terminalId: 7, seq: 2 },
    });
  });

  it("많은 작은 출력의 late join과 resync도 누락 없이 완료하고 이후 live 출력을 받는다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const expected: Array<[number, number, string]> = [];
    for (let seq = 1; seq <= 1024; seq++) {
      output(fixture.host, 7, seq, `line-${seq}`);
      expected.push([7, seq, `line-${seq}`]);
    }
    completeReplay(fixture.host, 7, 1024);
    await captureUntilSync(fixture.observer, 7);

    const late = (await fixture.join("late", "participant")).peer;
    const joined = await captureUntilSync(late, 7);
    late.send({ type: "resync-output-request", terminalId: 7 });
    const replayed = await captureUntilSync(late, 7);
    output(fixture.host, 7, 1025, "live-after-replay");
    completeReplay(fixture.host, 7, 1025);
    const live = await captureUntilSync(late, 7);

    expectOutput(joined, expected);
    expect(replayed).toEqual(joined);
    expect(joined.at(-1)).toEqual({
      kind: "control",
      message: { type: "sync", terminalId: 7, seq: 1024 },
    });
    expectOutput(live, [[7, 1025, "live-after-replay"]]);
    expect(live.at(-1)).toEqual({
      kind: "control",
      message: { type: "sync", terminalId: 7, seq: 1025 },
    });
  });

  it("같은 서버의 두 방에서 동일 hostId·terminalId의 출력이 섞이지 않는다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const roomB = await fixture.server.room("B");
    const observerB = (await fixture.join("alice", "participant", roomB)).peer;
    const hostB = (await fixture.join("host", "host", roomB)).peer;
    await reportInventory(hostB, [runtime(7)]);
    await observerB.next();
    await observerB.next();

    output(fixture.host, 7, 1, "room-a");
    output(hostB, 7, 1, "room-b");
    completeReplay(fixture.host, 7, 1);
    completeReplay(hostB, 7, 1);
    const a = await captureUntilSync(fixture.observer, 7);
    const b = await captureUntilSync(observerB, 7);

    expectOutput(a, [[7, 1, "room-a"]]);
    expectOutput(b, [[7, 1, "room-b"]]);
  });

  it("participant·다른 host의 출력과 잘못된 프레임을 거절해도 정상 출력은 유지한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const foreign = (await fixture.join("foreign", "host")).peer;

    output(fixture.observer, 7, 1, "participant");
    const participantError = await fixture.observer.next();
    output(foreign, 7, 1, "foreign");
    const foreignError = await foreign.next();
    fixture.host.sendBytes(Uint8Array.of(1, 2));
    const malformed = await fixture.host.next();
    output(fixture.host, 7, 1, "valid");
    completeReplay(fixture.host, 7, 1);
    const packets = await captureUntilSync(fixture.observer, 7);

    for (const error of [participantError, foreignError, malformed])
      expect(error).toMatchObject({ type: "error", code: "bad-message" });
    expectOutput(packets, [[7, 1, "valid"]]);
  });

  it("없는 terminal의 resync와 잘못된 replay 완료를 거절한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    fixture.observer.send({ type: "resync-output-request", terminalId: 99 });
    const resync = await fixture.observer.next();
    fixture.host.send({ type: "terminal-replay-complete", terminalId: 99, lastOutputSeq: 999 });
    const complete = await fixture.host.next();
    const ready = await reportInventory(fixture.host, [runtime(7)]);

    expect(resync).toEqual({
      type: "terminal-request-rejected",
      request: "resync-output",
      terminalId: 99,
      reason: "terminal-not-found",
    });
    expect(complete).toMatchObject({ type: "error", code: "bad-message" });
    expect(ready.ready.terminals).toEqual([{ terminalId: 7, replayAfterSeq: 0 }]);
  });
});

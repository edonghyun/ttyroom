import { describe, expect, it } from "vitest";
import { roomFixture } from "./fixtures.js";
import { SocketProbe } from "./socket-probe.js";
import {
  protocolRoomFixture as hostFixture,
  protocolWorkspaceFixture as readyHostFixture,
} from "./protocol-fixture.js";
import { given, waitUntil } from "./harness.js";

describe("Host 초기 연결 — Node/Spring 공통", () => {
  it("실제 Connector 프로세스가 초기 연결을 마치고 로컬 입력 허용 상태를 보고한다", async () => {
    await using fixture = await roomFixture();
    const observer = await given.participant(fixture.room, "alice");

    const connector = await given.connector(fixture.room, "computer");
    await waitUntil(() => observer.host(connector.hostId)?.remoteInputAllowed === true);

    expect(observer.host(connector.hostId)).toEqual({
      hostId: connector.hostId,
      name: "computer",
      online: true,
      remoteInputAllowed: true,
    });
    expect(observer.snapshot().terminals).toEqual([]);
  });

  it.each([
    { type: "host-inventory", terminals: [] },
    { type: "host-input-state", remoteInputAllowed: true },
  ])("hello 전에는 $type을 거절한다", async (command) => {
    await using fixture = await roomFixture();
    await using peer = await SocketProbe.connect(fixture.room.baseUrl);

    peer.send(command);
    const rejection = await peer.next();

    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
  });

  it("빈 inventory를 수락하면 host-ready와 입력 차단 상태의 host-connected를 보낸다", async () => {
    await using fixture = await hostFixture();

    fixture.host.send({ type: "host-inventory", terminals: [] });
    const ready = await fixture.host.next();
    const connected = await fixture.observer.next();
    const { welcome } = await fixture.join("late", "participant");

    expect(ready).toEqual({ type: "host-ready", terminals: [] });
    expect(connected).toEqual({
      type: "room-event",
      event: {
        kind: "host-connected",
        host: { hostId: "host", name: "host", online: true, remoteInputAllowed: false },
      },
    });
    expect(welcome.snapshot.hosts).toEqual([
      { hostId: "host", name: "host", online: true, remoteInputAllowed: false },
    ]);
  });

  it("Kill Switch 보고를 순서대로 반영하고 같은 상태 재보고는 알림을 늘리지 않는다", async () => {
    await using fixture = await readyHostFixture();

    fixture.host.send({ type: "host-input-state", remoteInputAllowed: true });
    fixture.host.send({ type: "host-input-state", remoteInputAllowed: true });
    fixture.host.send({ type: "host-input-state", remoteInputAllowed: false });
    // 같은 소켓의 후속 inventory 알림을 경계로 사용해 중복 알림 여부를 확인한다.
    fixture.host.send({ type: "host-inventory", terminals: [] });
    const events = [
      await fixture.observer.next(),
      await fixture.observer.next(),
      await fixture.observer.next(),
    ];
    const { welcome } = await fixture.join("late", "participant");

    expect(events).toMatchObject([
      {
        type: "room-event",
        event: { kind: "host-input-state-changed", hostId: "host", remoteInputAllowed: true },
      },
      {
        type: "room-event",
        event: { kind: "host-input-state-changed", hostId: "host", remoteInputAllowed: false },
      },
      { type: "room-event", event: { kind: "host-connected" } },
    ]);
    expect(welcome.snapshot.hosts[0]).toMatchObject({ online: true, remoteInputAllowed: false });
  });

  it("입력을 허용했던 host도 새 연결로 교체되면 inventory 전에는 offline·입력 차단 상태다", async () => {
    await using fixture = await readyHostFixture();
    fixture.host.send({ type: "host-input-state", remoteInputAllowed: true });
    await fixture.observer.next();

    const replacement = await fixture.join("host", "host");
    await fixture.host.closed();
    replacement.peer.send({ type: "host-inventory", terminals: [] });
    const ready = await replacement.peer.next();
    const connected = await fixture.observer.next();

    expect(replacement.welcome.snapshot.hosts).toEqual([
      { hostId: "host", name: "host", online: false, remoteInputAllowed: false },
    ]);
    expect(ready).toEqual({ type: "host-ready", terminals: [] });
    expect(connected).toMatchObject({
      type: "room-event",
      event: { kind: "host-connected", host: { online: true, remoteInputAllowed: false } },
    });
  });

  it("같은 clientId의 participant와 host는 서로 다른 세션이다", async () => {
    await using fixture = await hostFixture();
    const host = await fixture.join("alice", "host");

    host.peer.send({ type: "host-inventory", terminals: [] });
    const ready = await host.peer.next();
    const connected = await fixture.observer.next();

    expect(ready).toEqual({ type: "host-ready", terminals: [] });
    expect(connected).toMatchObject({
      type: "room-event",
      event: { kind: "host-connected", host: { hostId: "alice" } },
    });
  });

  it.each([
    { type: "host-inventory", terminals: [] },
    { type: "host-input-state", remoteInputAllowed: true },
  ])("participant 역할에서 $type 명령은 거절된다", async (command) => {
    await using fixture = await hostFixture();

    fixture.observer.send(command);
    const rejection = await fixture.observer.next();
    const { welcome } = await fixture.join("late", "participant");

    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
    expect(welcome.snapshot.hosts).toEqual([
      { hostId: "host", name: "host", online: false, remoteInputAllowed: false },
    ]);
  });

  it.each([
    ["terminals 누락", { type: "host-inventory" }],
    ["잘못된 배열", { type: "host-inventory", terminals: null }],
    [
      "잘못된 terminalId",
      {
        type: "host-inventory",
        terminals: [
          { terminalId: -1, runtimeId: "runtime", firstRetainedSeq: 0, lastOutputSeq: 0 },
        ],
      },
    ],
    [
      "빈 runtimeId",
      {
        type: "host-inventory",
        terminals: [{ terminalId: 1, runtimeId: "", firstRetainedSeq: 0, lastOutputSeq: 0 }],
      },
    ],
    [
      "잘못된 sequence",
      {
        type: "host-inventory",
        terminals: [
          { terminalId: 1, runtimeId: "runtime", firstRetainedSeq: 0, lastOutputSeq: 4294967296 },
        ],
      },
    ],
    ["잘못된 입력 상태", { type: "host-input-state", remoteInputAllowed: "true" }],
  ])("잘못된 보고(%s)를 거절한 뒤에도 정상 inventory를 처리한다", async (_name, invalid) => {
    await using fixture = await hostFixture();

    fixture.host.send(invalid);
    const rejection = await fixture.host.next();
    fixture.host.send({ type: "host-inventory", terminals: [] });
    const ready = await fixture.host.next();

    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
    expect(ready).toEqual({ type: "host-ready", terminals: [] });
  });
});

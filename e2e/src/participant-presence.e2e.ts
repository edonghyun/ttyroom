import { describe, expect, it } from "vitest";
import { protocolWorkspaceFixture } from "./protocol-fixture.js";
import { SocketProbe } from "./socket-probe.js";

const focus = (terminalId: unknown) => ({ type: "focus-terminal", terminalId });
const cursor = (position: unknown) => ({ type: "move-cursor", position });
const cursorEvent = (position: unknown) => ({
  type: "participant-cursor",
  clientId: "alice",
  position,
});
const focusEvent = (focusedTerminalId: number | null) => ({
  type: "room-event",
  event: { kind: "participant-focus-changed", clientId: "alice", focusedTerminalId },
});
async function request(peer: SocketProbe, command: unknown) {
  peer.send(command);
  return peer.next();
}
/** A FIFO reply exposes extra events without a timing-based absence check. */
async function boundary(peer: SocketProbe) {
  return request(peer, { type: "acquire-lease", terminalId: 0xfffffffe });
}
async function presenceFixture(ids: number[] = [7]) {
  const fixture = await protocolWorkspaceFixture(ids);
  try {
    async function participant(clientId: string) {
      const joined = await fixture.join(clientId, "participant");
      for (const terminal of joined.welcome.snapshot.terminals) {
        if (terminal.status !== "open") continue;
        const sync = await joined.peer.next();
        if (sync.type !== "sync" || sync.terminalId !== terminal.terminalId)
          throw new Error("Expected initial output sync before presence actions");
      }
      return joined;
    }
    const { peer: bob } = await participant("bob");
    const arrived = await fixture.observer.next();
    if (arrived.type !== "room-event" || arrived.event.kind !== "participant-joined")
      throw new Error("Expected Bob's arrival");
    return { ...fixture, alice: fixture.observer, bob, participant };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

async function focusableTerminalFixture(state: "exited" | "offline" | "pending") {
  const f = await presenceFixture(state === "pending" ? [] : [7]);
  try {
    let terminalId = 7;
    if (state === "pending") {
      f.alice.send({ type: "open-terminal-request", hostId: "host" });
      const opened = await f.host.next();
      if (opened.type !== "open-terminal") throw new Error("Expected reservation");
      terminalId = opened.terminalId;
    } else {
      if (state === "exited") f.host.send({ type: "terminal-closed", terminalId, exitCode: 0 });
      else await f.host.disconnect();
      await f.alice.next();
      await f.bob.next();
    }

    return { ...f, terminalId };
  } catch (error) {
    await f[Symbol.asyncDispose]();
    throw error;
  }
}

describe("참여자 focus·cursor — Node/Spring 공통", () => {
  it("focus와 blur를 본인·동료에게 알리고 후속 snapshot에 반영한다", async () => {
    await using f = await presenceFixture();

    const focused = await request(f.alice, focus(7));
    const observed = await f.bob.next();
    const beforeBlur = (await f.participant("before-blur")).welcome.snapshot;
    await f.alice.next();
    await f.bob.next();
    const blurred = await request(f.alice, focus(null));
    const observedBlur = await f.bob.next();
    const afterBlur = (await f.participant("after-blur")).welcome.snapshot;

    expect(focused).toEqual(focusEvent(7));
    expect(observed).toEqual(focused);
    expect(beforeBlur.participants).toContainEqual({
      clientId: "alice",
      name: "alice",
      focusedTerminalId: 7,
    });
    expect(blurred).toEqual(focusEvent(null));
    expect(observedBlur).toEqual(blurred);
    expect(afterBlur.participants).toContainEqual({
      clientId: "alice",
      name: "alice",
      focusedTerminalId: null,
    });
  });

  it("같은 focus·blur는 무응답이고 없는 대상은 기존 focus를 유지한 채 거절한다", async () => {
    await using f = await presenceFixture();

    f.alice.send(focus(null));
    const unchangedBlur = await boundary(f.alice);
    await request(f.alice, focus(7));
    await f.bob.next();
    f.alice.send(focus(7));
    const unchangedFocus = await boundary(f.alice);
    const missing = await request(f.alice, focus(99));
    const otherMessages = await boundary(f.bob);
    const late = (await f.participant("late")).welcome.snapshot;

    expect([unchangedBlur, unchangedFocus, otherMessages]).toMatchObject([
      { type: "lease-invalid" },
      { type: "lease-invalid" },
      { type: "lease-invalid" },
    ]);
    expect(missing).toMatchObject({ type: "error", code: "bad-message" });
    expect(late.participants).toContainEqual({
      clientId: "alice",
      name: "alice",
      focusedTerminalId: 7,
    });
  });

  it.each(["exited", "offline", "pending"] as const)(
    "%s 터미널에도 focus할 수 있다",
    async (state) => {
      await using f = await focusableTerminalFixture(state);
      const { terminalId } = f;

      const changed = await request(f.alice, focus(terminalId));
      const observed = await f.bob.next();

      expect(changed).toEqual(focusEvent(terminalId));
      expect(observed).toEqual(changed);
    },
  );

  it.each([
    { mode: "replace", given: focusedPresenceFixture },
    { mode: "reconnect", given: disconnectedFocusedPresenceFixture },
  ])("$mode는 focus를 복원하고 입장·focus를 재방송하지 않는다", async ({ given }) => {
    await using f = await given();

    const replacement = await f.participant("alice");
    const observerBoundary = await boundary(f.bob);
    const late = (await f.participant("late")).welcome.snapshot;

    expect(replacement.welcome.snapshot.participants).toContainEqual({
      clientId: "alice",
      name: "alice",
      focusedTerminalId: 7,
    });
    expect(observerBoundary).toMatchObject({ type: "lease-invalid" });
    expect(late.participants).toContainEqual({
      clientId: "alice",
      name: "alice",
      focusedTerminalId: 7,
    });
  });

  it("cursor는 반복·null도 다른 참여자에게만 전달하고 snapshot이나 늦은 접속에 재생하지 않는다", async () => {
    await using f = await presenceFixture([]);
    const position = { x: -65535, y: 65535 };

    f.alice.send(cursor(position));
    f.alice.send(cursor(position));
    f.alice.send(cursor(null));
    const updates = [await f.bob.next(), await f.bob.next(), await f.bob.next()];
    const noEcho = await boundary(f.alice);
    f.alice.send(cursor(position));
    const activeAgain = await f.bob.next();
    const late = await f.participant("late");
    const noReplay = await boundary(late.peer);

    expect(updates).toEqual([cursorEvent(position), cursorEvent(position), cursorEvent(null)]);
    expect(activeAgain).toEqual(cursorEvent(position));
    expect([noEcho, noReplay]).toMatchObject([
      { type: "lease-invalid" },
      { type: "lease-invalid" },
    ]);
    expect(late.welcome.snapshot.participants).toEqual([
      { clientId: "alice", name: "alice", focusedTerminalId: null },
      { clientId: "bob", name: "bob", focusedTerminalId: null },
      { clientId: "late", name: "late", focusedTerminalId: null },
    ]);
  });

  it("수신자 단절 중 cursor를 보관하지 않고 재접속 후 새 이동만 전달한다", async () => {
    await using f = await presenceFixture([]);
    await f.bob.disconnect();

    f.alice.send(cursor({ x: 1, y: 2 }));
    const processed = await boundary(f.alice);
    const replacement = await f.participant("bob");
    const noReplay = await boundary(replacement.peer);
    f.alice.send(cursor({ x: 3, y: 4 }));
    const live = await replacement.peer.next();

    expect([processed, noReplay]).toMatchObject([
      { type: "lease-invalid" },
      { type: "lease-invalid" },
    ]);
    expect(live).toEqual(cursorEvent({ x: 3, y: 4 }));
  });

  it("cursor는 focus·제어권·입력 허용 없이 소수 좌표를 전달하며 발신 ID를 세션에서 정한다", async () => {
    await using f = await presenceFixture();
    const position = { x: 120.5, y: -48.25 };

    f.alice.send({ ...cursor(position), clientId: "bob" });
    const received = await f.bob.next();
    const boundaryReply = await boundary(f.alice);

    expect(received).toEqual(cursorEvent(position));
    expect(boundaryReply).toMatchObject({ type: "lease-invalid" });
  });

  it("다른 방의 terminal은 focus할 수 없으며 cursor·focus 알림도 넘어가지 않는다", async () => {
    await using f = await presenceFixture();
    const roomB = await f.server.room("B");
    const other = (await f.join("other", "participant", roomB)).peer;

    const rejected = await request(other, focus(7));
    await request(f.alice, focus(7));
    await f.bob.next();
    f.alice.send(cursor({ x: 1, y: 2 }));
    await f.bob.next();
    const isolated = await boundary(other);

    expect(rejected).toMatchObject({ type: "error", code: "bad-message" });
    expect(isolated).toMatchObject({ type: "lease-invalid" });
  });

  it("잘못된 focus·cursor 뒤에도 정상 명령을 처리한다", async () => {
    await using f = await presenceFixture();
    const invalid = [
      ...[undefined, -1, 1.5, 4294967296, "7"].map(focus),
      ...[
        undefined,
        1,
        [],
        {},
        { x: 1 },
        { x: "1", y: 1 },
        { x: -65536, y: 0 },
        { x: 0, y: 65536 },
      ].map(cursor),
      '{"type":"move-cursor","position":{"x":1e309,"y":0}}',
    ];

    const errors = [];
    for (const command of invalid) errors.push(await request(f.alice, command));
    const valid = await request(f.alice, focus(7));

    expect(errors).toEqual(
      invalid.map(() => expect.objectContaining({ type: "error", code: "bad-message" })),
    );
    expect(valid).toEqual(focusEvent(7));
  });

  it.each([focus(7), cursor(null)])("host와 hello 전의 $type 요청은 거절한다", async (command) => {
    await using f = await presenceFixture();
    await using stranger = await SocketProbe.connect(f.room.baseUrl);

    const host = await request(f.host, command);
    const anonymous = await request(stranger, command);

    expect([host, anonymous]).toMatchObject([
      { type: "error", code: "bad-message" },
      { type: "error", code: "bad-message" },
    ]);
  });
});

async function focusedPresenceFixture() {
  const fixture = await presenceFixture();
  try {
    await request(fixture.alice, focus(7));
    await fixture.bob.next();
    return fixture;
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

async function disconnectedFocusedPresenceFixture() {
  const fixture = await focusedPresenceFixture();
  try {
    await fixture.alice.disconnect();
    return fixture;
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

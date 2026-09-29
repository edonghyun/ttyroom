import { unavailableTerminalStates, closedTerminalStates } from "./terminal-state-fixtures.js";
import { describe, expect, it } from "vitest";
import { protocolWorkspaceFixture } from "./protocol-fixture.js";
import { controlledTerminalFixture } from "./fixtures.js";
import { printOutput } from "./actions.js";
import { assertOutputContains } from "./assertions.js";
import { acquire, inputFixture, sendInput } from "./protocol-input-fixture.js";

describe("Exclusive 입력 — Node/Spring 공통", () => {
  it("획득 결과 다음에 이벤트를 보내고 재획득은 같은 lease를 반환한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    const first = await acquire(fixture.observer);
    const event = await fixture.observer.next();
    const repeated = await acquire(fixture.observer);
    const { welcome } = await fixture.join("late", "participant");
    const boundary = await fixture.observer.next();

    expect(first).toEqual({
      type: "lease-result",
      terminalId: 7,
      result: { kind: "granted", leaseId: 1 },
    });
    expect(event).toEqual({
      type: "room-event",
      event: {
        kind: "lease-granted",
        lease: { terminalId: 7, leaseId: 1, holderClientId: "alice" },
      },
    });
    expect(repeated).toEqual(first);
    expect(boundary).toMatchObject({
      event: { kind: "participant-joined", participant: { clientId: "late" } },
    });
    expect(welcome.snapshot.leases).toEqual([
      { terminalId: 7, leaseId: 1, holderClientId: "alice" },
    ]);
  });

  it("다른 참여자에게 거절하고 다른 terminal로 옮기면 이전 lease부터 반납한다", async () => {
    await using fixture = await inputFixture();
    const bob = (await fixture.joinParticipant("bob")).peer;
    await fixture.observer.next();

    const denied = await acquire(bob);
    const moved = await acquire(fixture.observer, 8);
    const events = [await fixture.observer.next(), await fixture.observer.next()];

    expect(denied).toEqual({
      type: "lease-result",
      terminalId: 7,
      result: { kind: "denied", holderClientId: "alice" },
    });
    expect(moved).toMatchObject({ result: { kind: "granted", leaseId: 2 } });
    expect(events).toMatchObject([
      { event: { kind: "lease-released", terminalId: 7 } },
      { event: { kind: "lease-granted", lease: { terminalId: 8, holderClientId: "alice" } } },
    ]);
  });

  it("잘못된 lease 반납은 거절하고 정확한 반납 뒤에는 이전 입력을 차단한다", async () => {
    await using fixture = await inputFixture();

    fixture.observer.send({ type: "release-lease", terminalId: 7, leaseId: fixture.leaseId + 1 });
    const wrong = await fixture.observer.next();
    fixture.observer.send({ type: "release-lease", terminalId: 7, leaseId: fixture.leaseId });
    const released = await fixture.observer.next();
    sendInput(fixture.observer, fixture.leaseId);
    const stale = await fixture.observer.next();
    const { welcome } = await fixture.join("late", "participant");

    expect(wrong).toEqual({ type: "lease-invalid", terminalId: 7, reason: "not-holder" });
    expect(released).toMatchObject({ event: { kind: "lease-released", terminalId: 7 } });
    expect(stale).toEqual(wrong);
    expect(welcome.snapshot.leases).toEqual([]);
  });

  it("입력 bytes와 u32 seq를 그대로 전달하며 반복 seq도 중복 제거하지 않는다", async () => {
    await using fixture = await inputFixture();

    const expected = sendInput(fixture.observer, fixture.leaseId, 7, 0xffffffff);
    const first = await fixture.host.nextPacket();
    sendInput(fixture.observer, fixture.leaseId, 7, 0xffffffff);
    const repeated = await fixture.host.nextPacket();

    expect(first).toEqual(expected);
    expect(repeated).toEqual(expected);
  });

  it("Kill Switch 차단은 lease를 유지하며 재허용 후 같은 lease로 입력한다", async () => {
    await using fixture = await inputFixture();

    fixture.host.send({ type: "host-input-state", remoteInputAllowed: false });
    await fixture.observer.next();
    sendInput(fixture.observer, fixture.leaseId);
    const rejection = await fixture.observer.next();
    fixture.host.send({ type: "host-input-state", remoteInputAllowed: true });
    await fixture.observer.next();
    const expected = sendInput(fixture.observer, fixture.leaseId);
    const forwarded = await fixture.host.nextPacket();
    const { welcome } = await fixture.join("late", "participant");

    expect(rejection).toEqual({
      type: "lease-invalid",
      terminalId: 7,
      reason: "remote-input-disabled",
    });
    expect(forwarded).toEqual(expected);
    expect(welcome.snapshot.leases).toMatchObject([{ terminalId: 7, leaseId: fixture.leaseId }]);
  });

  it("잘못된 lease와 다른 참여자의 입력은 host에 도달하지 않는다", async () => {
    await using fixture = await inputFixture();
    const bob = (await fixture.joinParticipant("bob")).peer;
    await fixture.observer.next();

    sendInput(fixture.observer, fixture.leaseId + 1);
    const wrongId = await fixture.observer.next();
    sendInput(bob, fixture.leaseId);
    const wrongOwner = await bob.next();
    const expected = sendInput(fixture.observer, fixture.leaseId);
    const forwarded = await fixture.host.nextPacket();

    expect([wrongId, wrongOwner]).toEqual(
      Array.from({ length: 2 }, () => ({
        type: "lease-invalid",
        terminalId: 7,
        reason: "not-holder",
      })),
    );
    expect(forwarded).toEqual(expected);
  });

  it("참여자 재접속은 유예 중 lease를 snapshot으로 복원한다", async () => {
    await using fixture = await inputFixture();
    await fixture.observer.disconnect();

    const replacement = await fixture.joinParticipant("alice");
    const expected = sendInput(replacement.peer, fixture.leaseId);
    const forwarded = await fixture.host.nextPacket();

    expect(replacement.welcome.snapshot.leases).toMatchObject([
      { leaseId: fixture.leaseId, holderClientId: "alice" },
    ]);
    expect(forwarded).toEqual(expected);
  });

  it.each(unavailableTerminalStates)(
    "$name terminal의 입력은 terminal-closed로 거절한다",
    async (state) => {
      await using fixture = await inputFixture();
      await state.prepare(fixture);

      sendInput(fixture.observer, fixture.leaseId, state.terminalId);
      const rejection = await fixture.observer.next();

      expect(rejection).toEqual({
        type: "lease-invalid",
        terminalId: state.terminalId,
        reason: "terminal-closed",
      });
    },
  );

  it.each(closedTerminalStates)(
    "$name terminal은 입력 거절 후 제어권 획득도 거절한다",
    async (state) => {
      await using fixture = await inputFixture();
      await state.prepare(fixture);
      sendInput(fixture.observer, fixture.leaseId, state.terminalId);
      await fixture.observer.next();

      const acquisition = await acquire(fixture.observer, state.terminalId);

      expect(acquisition).toEqual({
        type: "lease-invalid",
        terminalId: state.terminalId,
        reason: "terminal-closed",
      });
    },
  );

  it("host 교체 뒤에는 새 연결이 입력 허용을 보고해야 전달한다", async () => {
    await using fixture = await inputFixture();
    const replacement = (await fixture.join("host", "host")).peer;

    sendInput(fixture.observer, fixture.leaseId);
    const rejected = await fixture.observer.next();
    replacement.send({ type: "host-input-state", remoteInputAllowed: true });
    await fixture.observer.next();
    const expected = sendInput(fixture.observer, fixture.leaseId);
    const forwarded = await replacement.nextPacket();

    expect(rejected).toMatchObject({ type: "lease-invalid", reason: "remote-input-disabled" });
    expect(forwarded).toEqual(expected);
  });

  it("host의 lease 요청·입력과 malformed binary를 거절해도 정상 입력은 유지한다", async () => {
    await using fixture = await inputFixture();

    const role = await acquire(fixture.host);
    sendInput(fixture.host, fixture.leaseId);
    const hostInput = await fixture.host.next();
    fixture.observer.sendBytes(new Uint8Array([2, 0, 0]));
    const malformed = await fixture.observer.next();
    const expected = sendInput(fixture.observer, fixture.leaseId);
    const forwarded = await fixture.host.nextPacket();

    expect([role, hostInput, malformed]).toMatchObject(
      Array.from({ length: 3 }, () => ({ type: "error", code: "bad-message" })),
    );
    expect(forwarded).toEqual(expected);
  });

  it("방이 다르면 같은 host·terminal·lease ID의 입력도 각 Connector로만 전달한다", async () => {
    await using fixture = await inputFixture();
    const roomB = await fixture.server.room("B");
    const aliceB = (await fixture.join("alice", "participant", roomB)).peer;
    const hostB = (await fixture.join("host", "host", roomB)).peer;
    hostB.send({
      type: "host-inventory",
      terminals: [{ terminalId: 7, runtimeId: "runtime-7", firstRetainedSeq: 0, lastOutputSeq: 0 }],
    });
    await hostB.next();
    await aliceB.next();
    await aliceB.next();
    hostB.send({ type: "host-input-state", remoteInputAllowed: true });
    await aliceB.next();
    const leaseB = await acquire(aliceB);
    if (leaseB.type !== "lease-result" || leaseB.result.kind !== "granted")
      throw new Error("Room B requires a lease");
    await aliceB.next();

    const expectedA = sendInput(fixture.observer, fixture.leaseId, 7, 17);
    const expectedB = sendInput(aliceB, leaseB.result.leaseId, 7, 18);
    const receivedA = await fixture.host.nextPacket();
    const receivedB = await hostB.nextPacket();

    expect(leaseB.result.leaseId).toBe(fixture.leaseId);
    expect(receivedA).toEqual(expectedA);
    expect(receivedB).toEqual(expectedB);
  });

  it("실제 Connector의 셸에 입력하여 echo와 구분되는 실행 결과를 받는다", async () => {
    await using fixture = await controlledTerminalFixture(["alice", "bob"]);

    printOutput(fixture.participants.alice, fixture.terminalId, "spring-input-executed");

    await assertOutputContains(
      fixture.participants.alice,
      fixture.terminalId,
      "spring-input-executed",
    );
    await assertOutputContains(
      fixture.participants.bob,
      fixture.terminalId,
      "spring-input-executed",
    );
  });
});

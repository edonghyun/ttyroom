import { unavailableTerminalStates } from "./terminal-state-fixtures.js";
import { describe, expect, it } from "vitest";
import { acquire, inputFixture, sharedInputFixture, sendInput } from "./protocol-input-fixture.js";
import { terminalFixture } from "./fixtures.js";
import { printOutput } from "./actions.js";
import { assertOutputContains } from "./assertions.js";
import { SocketProbe } from "./socket-probe.js";

async function changeMode(peer: SocketProbe, mode: "shared" | "exclusive", terminalId = 7) {
  peer.send({ type: "set-terminal-mode", terminalId, mode });
  return peer.next();
}
const modeEvent = (mode: "shared" | "exclusive") => ({
  type: "room-event",
  event: { kind: "terminal-mode-changed", terminalId: 7, mode },
});

describe("Terminal 모드 — Node/Spring 공통", () => {
  it("제어권 없는 참여자도 모드를 바꾸며 모두에게 알리고 기존 lease를 유지한다", async () => {
    await using fixture = await inputFixture();
    const bob = (await fixture.joinParticipant("bob")).peer;
    await fixture.observer.next();

    const reply = await changeMode(bob, "shared");
    const broadcast = await fixture.observer.next();
    const { welcome } = await fixture.join("late", "participant");

    expect(reply).toEqual(modeEvent("shared"));
    expect(broadcast).toEqual(reply);
    expect(welcome.snapshot.terminals).toMatchObject([
      { terminalId: 7, mode: "shared" },
      { terminalId: 8, mode: "exclusive" },
    ]);
    expect(welcome.snapshot.leases).toEqual([
      { terminalId: 7, leaseId: fixture.leaseId, holderClientId: "alice" },
    ]);
  });

  it("같은 모드 재요청은 추가 이벤트 없이 다음 명령을 처리한다", async () => {
    await using fixture = await sharedInputFixture();

    fixture.observer.send({ type: "set-terminal-mode", terminalId: 7, mode: "shared" });
    const nextReply = await acquire(fixture.observer);

    expect(nextReply).toEqual({ type: "lease-invalid", terminalId: 7, reason: "terminal-closed" });
  });

  it("shared는 임의 lease ID 입력을 허용하고 exclusive 복귀는 원래 소유자만 허용한다", async () => {
    await using fixture = await sharedInputFixture();
    const bob = (await fixture.joinParticipant("bob")).peer;
    await fixture.observer.next();

    const expectedShared = sendInput(bob, 0);
    const sharedInput = await fixture.host.nextPacket();
    const changed = await changeMode(bob, "exclusive");
    await fixture.observer.next();
    sendInput(bob, fixture.leaseId);
    const rejection = await bob.next();
    const expectedExclusive = sendInput(fixture.observer, fixture.leaseId, 7, 18);
    const exclusiveInput = await fixture.host.nextPacket();
    const { welcome } = await fixture.join("late", "participant");

    expect(sharedInput).toEqual(expectedShared);
    expect(changed).toEqual(modeEvent("exclusive"));
    expect(rejection).toEqual({ type: "lease-invalid", terminalId: 7, reason: "not-holder" });
    expect(exclusiveInput).toEqual(expectedExclusive);
    expect(welcome.snapshot.leases).toMatchObject([
      { leaseId: fixture.leaseId, holderClientId: "alice" },
    ]);
  });

  it("shared의 획득 거절은 다른 terminal에 가진 lease를 해제하지 않는다", async () => {
    await using fixture = await sharedInputFixture();
    const bob = (await fixture.joinParticipant("bob")).peer;
    await fixture.observer.next();
    await acquire(bob, 8);
    await bob.next();
    await fixture.observer.next();

    const rejected = await acquire(bob, 7);
    const { welcome } = await fixture.join("late", "participant");

    expect(rejected).toEqual({ type: "lease-invalid", terminalId: 7, reason: "terminal-closed" });
    expect(welcome.snapshot.leases).toMatchObject([
      { terminalId: 7, holderClientId: "alice" },
      { terminalId: 8, holderClientId: "bob" },
    ]);
  });

  it("shared에서 반납한 lease는 exclusive 복귀로 부활하지 않는다", async () => {
    await using fixture = await sharedInputFixture();

    fixture.observer.send({ type: "release-lease", terminalId: 7, leaseId: fixture.leaseId });
    const released = await fixture.observer.next();
    await changeMode(fixture.observer, "exclusive");
    sendInput(fixture.observer, fixture.leaseId);
    const rejected = await fixture.observer.next();
    const acquired = await acquire(fixture.observer);

    expect(released).toMatchObject({ event: { kind: "lease-released", terminalId: 7 } });
    expect(rejected).toMatchObject({ type: "lease-invalid", reason: "not-holder" });
    expect(acquired).toMatchObject({ result: { kind: "granted", leaseId: fixture.leaseId + 1 } });
  });

  it.each(unavailableTerminalStates)(
    "$name에서는 같은 모드 재요청도 $reason로 거절한다",
    async (state) => {
      await using fixture = await inputFixture();
      await state.prepare(fixture);
      const { terminalId, reason } = state;

      const rejection = await changeMode(fixture.observer, "exclusive", terminalId);
      const { welcome } = await fixture.join("late", "participant");

      expect(rejection).toEqual({
        type: "terminal-request-rejected",
        request: "set-mode",
        terminalId,
        reason,
      });
      expect(welcome.snapshot.terminals.every((t) => t.mode === "exclusive")).toBe(true);
      expect(welcome.snapshot.leases).toMatchObject([{ leaseId: fixture.leaseId }]);
    },
  );

  it("shared에서도 Kill Switch가 입력을 차단하며 재허용 후 입력한다", async () => {
    await using fixture = await sharedInputFixture();
    fixture.host.send({ type: "host-input-state", remoteInputAllowed: false });
    await fixture.observer.next();

    sendInput(fixture.observer, 0);
    const rejected = await fixture.observer.next();
    fixture.host.send({ type: "host-input-state", remoteInputAllowed: true });
    await fixture.observer.next();
    const expected = sendInput(fixture.observer, 0xffffffff);
    const delivered = await fixture.host.nextPacket();

    expect(rejected).toMatchObject({ type: "lease-invalid", reason: "remote-input-disabled" });
    expect(delivered).toEqual(expected);
  });

  it("잘못된 역할·mode·ID를 거절한 뒤 정상 요청을 처리한다", async () => {
    await using fixture = await inputFixture();

    const role = await changeMode(fixture.host, "shared");
    fixture.observer.send({ type: "set-terminal-mode", terminalId: 7, mode: "unknown" });
    const mode = await fixture.observer.next();
    fixture.observer.send({ type: "set-terminal-mode", terminalId: -1, mode: "shared" });
    const id = await fixture.observer.next();
    const valid = await changeMode(fixture.observer, "shared");

    expect([role, mode, id]).toMatchObject(
      Array.from({ length: 3 }, () => ({ type: "error", code: "bad-message" })),
    );
    expect(valid).toEqual(modeEvent("shared"));
  });

  it("host 교체 후 inventory 전에도 모드를 바꾸되 입력은 새 허용 보고를 기다린다", async () => {
    await using fixture = await inputFixture();
    const replacement = (await fixture.join("host", "host")).peer;

    const changed = await changeMode(fixture.observer, "shared");
    sendInput(fixture.observer, 0);
    const rejected = await fixture.observer.next();
    replacement.send({ type: "host-input-state", remoteInputAllowed: true });
    await fixture.observer.next();
    const expected = sendInput(fixture.observer, 0);
    const delivered = await replacement.nextPacket();

    expect(changed).toEqual(modeEvent("shared"));
    expect(rejected).toMatchObject({ reason: "remote-input-disabled" });
    expect(delivered).toEqual(expected);
  });

  it("같은 terminal ID가 있는 다른 방의 모드는 바꾸지 않는다", async () => {
    await using fixture = await inputFixture();
    const roomB = await fixture.server.room("B");
    const hostB = (await fixture.join("host", "host", roomB)).peer;
    hostB.send({
      type: "host-inventory",
      terminals: [{ terminalId: 7, runtimeId: "runtime-7", firstRetainedSeq: 0, lastOutputSeq: 0 }],
    });
    await hostB.next();

    const changed = await changeMode(fixture.observer, "shared");
    const { welcome } = await fixture.join("alice", "participant", roomB);

    expect(changed).toEqual(modeEvent("shared"));
    expect(welcome.snapshot.terminals).toMatchObject([{ terminalId: 7, mode: "exclusive" }]);
    expect(welcome.snapshot.leases).toEqual([]);
  });

  it("hello 전 모드 변경 요청을 거절한다", async () => {
    await using fixture = await inputFixture();
    await using stranger = await SocketProbe.connect(fixture.room.baseUrl);

    const rejection = await changeMode(stranger, "shared");

    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
  });

  it("실제 Connector의 shared 셸은 제어권 없는 참여자의 명령을 실행한다", async () => {
    await using fixture = await terminalFixture(["alice", "bob"]);
    const { alice, bob } = fixture.participants;

    await bob.changeTerminalMode(fixture.terminalId, "shared");
    printOutput(bob, fixture.terminalId, "shared-executed");

    await assertOutputContains(alice, fixture.terminalId, "shared-executed");
    await assertOutputContains(bob, fixture.terminalId, "shared-executed");
  });
});

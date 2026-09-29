import {
  outputHistoryFixture,
  connectedRoomFixture,
  isolatedRoomsFixture,
  controlledTerminalFixture,
  roomFixture,
  terminalFixture,
} from "./fixtures.js";
import { captureOutputReplay, printOutput } from "./actions.js";
import {
  assertRoomOutputIsolated,
  assertControlDenied,
  assertOutputContains,
  assertTerminalState,
  assertControlHolder,
  assertReplayCompleted,
} from "./assertions.js";
import { describe, expect, it } from "vitest";
import { given } from "./harness.js";

describe("방 참여와 터미널 협업", () => {
  it("잘못된 초대 토큰은 거절하고 같은 방의 정상 입장은 계속 허용한다", async () => {
    await using fixture = await roomFixture();
    const { room } = fixture;

    const rejectedJoin = await given
      .participant({ ...room, token: "invalid" }, "intruder")
      .catch((error: unknown) => error);
    const alice = await given.participant(room, "alice");

    expect(rejectedJoin).toBeInstanceOf(Error);
    expect(rejectedJoin).toMatchObject({ message: expect.stringContaining("invalid-token") });
    expect(alice.snapshot().participants.map((participant) => participant.name)).toEqual(["alice"]);
  });

  it("동시 입력권 요청은 한 명만 승인하고 두 참여자가 같은 소유자를 관찰한다", async () => {
    await using fixture = await terminalFixture(["alice", "bob"]);
    const { terminalId } = fixture;
    const { alice, bob } = fixture.participants;

    const [aliceResult, bobResult] = await Promise.all([
      alice.requestControl(terminalId),
      bob.requestControl(terminalId),
    ]);

    const winner = aliceResult.kind === "granted" ? alice : bob;
    const denied = aliceResult.kind === "denied" ? aliceResult : bobResult;
    printOutput(winner, terminalId, "winner-executed");

    expect([aliceResult.kind, bobResult.kind].sort()).toEqual(["denied", "granted"]);
    assertControlDenied(denied, winner);
    for (const participant of [alice, bob]) {
      await assertControlHolder(participant, terminalId, winner);
    }

    for (const participant of [alice, bob]) {
      await assertOutputContains(participant, terminalId, "winner-executed");
    }
  });

  it("터미널 이름과 위치 변경은 다른 참여자와 늦게 입장한 참여자에게도 보인다", async () => {
    await using fixture = await terminalFixture(["alice", "bob"]);
    const { room, terminalId } = fixture;
    const { alice, bob } = fixture.participants;
    const geometry = { x: 123, y: 87, width: 720, height: 420 };

    await alice.renameTerminal(terminalId, "API logs");
    await alice.updateGeometry(terminalId, geometry);
    const carol = await given.participant(room, "carol");

    for (const participant of [bob, carol]) {
      await assertTerminalState(participant, terminalId, { title: "API logs", geometry });
    }
  });

  it("다른 방에서 같은 terminalId를 써도 출력이 섞이지 않는다", async () => {
    await using fixture = await isolatedRoomsFixture();
    const { alice, bob, terminalId } = fixture;

    printOutput(alice, terminalId, "room-a-only");
    printOutput(bob, terminalId, "room-b-only");

    const aliceOutput = await captureOutputReplay(alice, terminalId, "room-a-only");
    const bobOutput = await captureOutputReplay(bob, terminalId, "room-b-only");

    assertRoomOutputIsolated(aliceOutput, {
      ownOutput: "room-a-only",
      foreignOutput: "room-b-only",
    });
    assertRoomOutputIsolated(bobOutput, {
      ownOutput: "room-b-only",
      foreignOutput: "room-a-only",
    });
  });

  it("방에 붙인 이름이 입장한 참여자에게도 보인다", async () => {
    await using fixture = await roomFixture({ name: "Payment Debug" });
    const { room } = fixture;
    const alice = await given.participant(room, "alice");

    expect(room.name).toBe("Payment Debug");
    expect(alice.snapshot().name).toBe("Payment Debug");
  });

  it("한 참여자가 실행한 명령의 결과를 두 참여자가 함께 본다", async () => {
    await using fixture = await controlledTerminalFixture(["alice", "bob"]);
    const { terminalId } = fixture;
    const { alice, bob } = fixture.participants;

    printOutput(alice, terminalId, "collab-ok");

    await assertOutputContains(bob, terminalId, "collab-ok");
    await assertOutputContains(alice, terminalId, "collab-ok");
  });

  it("늦게 입장한 참여자도 이전 출력과 재생 완료 지점을 받는다", async () => {
    await using fixture = await outputHistoryFixture("before-carol");
    const { room, terminalId } = fixture;

    const carol = await given.participant(room, "carol");

    await assertOutputContains(carol, terminalId, "before-carol");
    await assertReplayCompleted(carol, terminalId);
  });

  it("출력 재동기화를 요청하면 이전 출력과 완료 지점을 다시 받는다", async () => {
    await using fixture = await outputHistoryFixture("replay-on-demand");
    const { terminalId } = fixture;
    const { alice } = fixture.participants;

    await alice.resyncOutput(terminalId);

    expect(alice.outputText(terminalId)).toContain("replay-on-demand");
    expect(alice.syncedSeq(terminalId)).toBeGreaterThan(0);
  });

  it("공유 모드로 바꾸면 참여자가 보는 터미널 상태가 갱신된다", async () => {
    await using fixture = await terminalFixture(["alice"]);
    const { terminalId } = fixture;
    const { alice } = fixture.participants;

    await alice.changeTerminalMode(terminalId, "shared");

    expect(alice.terminal(terminalId)?.mode).toBe("shared");
  });

  it("터미널 닫기를 요청하면 로컬 셸 종료 후 종료 상태로 표시된다", async () => {
    await using fixture = await terminalFixture(["alice"]);
    const { terminalId } = fixture;
    const { alice } = fixture.participants;

    await alice.closeTerminal(terminalId);

    await assertTerminalState(alice, terminalId, { status: "exited" });
  });

  it("점유된 터미널은 현재 소유자를 알려주며 입력권 요청을 거절한다", async () => {
    await using fixture = await controlledTerminalFixture(["alice", "bob"]);
    const { terminalId } = fixture;
    const { alice, bob } = fixture.participants;

    const result = await bob.requestControl(terminalId);

    assertControlDenied(result, alice);
  });

  it("서로 다른 컴퓨터에서 동시에 터미널을 열면 각 컴퓨터에 맞는 결과를 받는다", async () => {
    await using fixture = await connectedRoomFixture(["alice", "bob"]);
    const { room, connector: hostA } = fixture;
    const { alice, bob } = fixture.participants;
    const hostB = await given.connector(room, "host-b");

    const [terminalA, terminalB] = await Promise.all([
      alice.openTerminal(hostA.hostId),
      bob.openTerminal(hostB.hostId),
    ]);

    expect(alice.terminal(terminalA)?.hostId).toBe(hostA.hostId);
    expect(bob.terminal(terminalB)?.hostId).toBe(hostB.hostId);
  });

  it("동시에 연결한 컴퓨터는 각자 요청한 이름으로 표시된다", async () => {
    await using fixture = await roomFixture();
    const { room } = fixture;

    const [hostA, hostB] = await Promise.all([
      given.connector(room, "concurrent-a"),
      given.connector(room, "concurrent-b"),
    ]);
    const observer = await given.participant(room, "observer");

    expect(hostA.hostId).not.toBe(hostB.hostId);
    expect(observer.snapshot().hosts).toContainEqual(
      expect.objectContaining({ hostId: hostA.hostId, name: "concurrent-a" }),
    );
    expect(observer.snapshot().hosts).toContainEqual(
      expect.objectContaining({ hostId: hostB.hostId, name: "concurrent-b" }),
    );
  });

  it("같은 이름으로 연결한 두 컴퓨터도 서로 구분된다", async () => {
    await using fixture = await roomFixture();
    const { room } = fixture;

    const [hostA, hostB] = await Promise.all([
      given.connector(room, "duplicate-name"),
      given.connector(room, "duplicate-name"),
    ]);

    expect(hostA.hostId).not.toBe(hostB.hostId);
  });

  it("한 참여자가 동시에 두 터미널을 열면 서로 다른 터미널이 생성된다", async () => {
    await using fixture = await connectedRoomFixture(["alice"]);
    const { connector: host } = fixture;
    const { alice } = fixture.participants;

    const terminalIds = await Promise.all([
      alice.openTerminal(host.hostId),
      alice.openTerminal(host.hostId),
    ]);

    expect(new Set(terminalIds).size).toBe(2);
  });
});

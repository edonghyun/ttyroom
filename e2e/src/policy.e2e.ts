import { describe, expect, it } from "vitest";
import { outputPolicyScenario, participantPolicyScenario } from "./policy-scenario.js";

describe("설정 정책 — Node·Spring 공통", () => {
  it.each([
    { bytes: 3, retained: ["bbb"] },
    { bytes: 0, retained: [] },
  ])("보관량 $bytes bytes는 후속 입장자의 replay 범위를 결정한다", async ({ bytes, retained }) => {
    await using scenario = await outputPolicyScenario({ scrollbackBytesPerTerminal: bytes });

    const live = await scenario.publishOutput("a", "bbb");
    const replay = await scenario.replayFor("late");

    expect(live.texts).toEqual(["a", "bbb"]);
    expect(replay.texts).toEqual(retained);
    expect(replay.sync).toMatchObject({ terminalId: 7, seq: 2 });
  });

  it("송신 드롭 기준 0은 live 출력만 버리고 보관된 replay는 유지한다", async () => {
    await using scenario = await outputPolicyScenario({ sendBufferDropThresholdBytes: 0 });

    const live = await scenario.publishOutput("saved");
    const replay = await scenario.replayFor("late");

    expect(live.texts).toEqual([]);
    expect(replay.texts).toEqual(["saved"]);
  });

  it("수신 바이너리 한도는 header를 포함하며 경계 크기를 허용한다", async () => {
    await using scenario = await outputPolicyScenario({ maxQueuedDataBytesPerConnection: 10 });

    const received = await scenario.publishOutput("a");

    expect(received.texts).toEqual(["a"]);
  });

  it("수신 바이너리 한도를 초과한 연결을 종료한다", async () => {
    await using scenario = await outputPolicyScenario({ maxQueuedDataBytesPerConnection: 10 });

    scenario.sendOutput("ab");
    const offline = await scenario.hostDisconnection();

    expect(offline).toMatchObject({
      type: "room-event",
      event: { kind: "host-offline", hostId: "host" },
    });
  });

  it("참여자 유예 0은 단절한 참여자를 제거한다", async () => {
    await using scenario = await participantPolicyScenario({ participantGraceMs: 0 });

    const left = await scenario.disconnectParticipant();

    expect(left).toMatchObject({
      type: "room-event",
      event: { kind: "participant-left", clientId: "bob" },
    });
  });
});

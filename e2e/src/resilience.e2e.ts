import { controlledTerminalFixture, outputHistoryFixture, terminalFixture } from "./fixtures.js";
import { reconnectToHost, runUntilOutput } from "./actions.js";
import {
  assertControlGranted,
  assertOutputContains,
  assertTerminalState,
  assertControlHolder,
  assertHostDisconnected,
  assertReplayExactlyOnce,
} from "./assertions.js";
import { describe, expect, it } from "vitest";
import { printMarker } from "./shell-commands.js";

describe("회복 탄력성 — 단절과 유예", () => {
  it("서버 재시작 뒤 같은 PTY·terminalId·공유 상태를 복원하고 단절 중 출력을 replay한다", async () => {
    await using fixture = await controlledTerminalFixture(["alice"], {
      name: "Restart Safe",
      policy: { hostGraceMs: 3_000 },
    });
    const { server, connector, terminalId } = fixture;
    const { alice } = fixture.participants;
    await alice.renameTerminal(terminalId, "API logs");
    await alice.updateGeometry(terminalId, { x: 120, y: 80, width: 720, height: 480 });
    const prepareShell = [
      "export TTYROOM_RESTART_SENTINEL=pty-'survived'",
      `(sleep 0.2; ${printMarker("offline-output-marker").trimEnd()}) &`,
      printMarker("restart-armed"),
    ].join("\n");
    await runUntilOutput(alice, terminalId, prepareShell, "restart-armed");

    const previousPid = server.processId;
    await server.restart(500);
    await reconnectToHost(alice, connector.hostId);
    const restoredState = alice.snapshot();
    const controlResult = await alice.requestControl(terminalId);
    alice.sendInput(terminalId, "printf '%s\\n' \"$TTYROOM_RESTART_SENTINEL\"\n");

    expect(server.processId).not.toBe(previousPid);
    await expect.poll(() => alice.host(connector.hostId)).toMatchObject({ online: true });
    await assertOutputContains(alice, terminalId, "offline-output-marker");
    await assertTerminalState(alice, terminalId, {
      title: "API logs",
      geometry: { x: 120, y: 80, width: 720, height: 480 },
      status: "open",
    });
    expect(restoredState.leases).toEqual([]);
    assertControlGranted(controlResult);
    await assertOutputContains(alice, terminalId, "pty-survived");
  });

  it("참여자가 유예 내 같은 clientId로 재접속하면 임대가 유지된다", async () => {
    await using fixture = await controlledTerminalFixture(["alice"], {
      policy: { participantGraceMs: 3_000 },
    });
    const { terminalId } = fixture;
    const { alice } = fixture.participants;

    alice.close();
    await alice.reconnect();

    await assertControlHolder(alice, terminalId, alice);
  });

  it("connector 프로세스 종료는 host-offline을 알리고 유예 뒤 host와 터미널을 제거한다", async () => {
    await using fixture = await terminalFixture(["bob"], { policy: { hostGraceMs: 100 } });
    const { connector, terminalId } = fixture;
    const { bob } = fixture.participants;

    connector.kill();

    await assertHostDisconnected(bob, connector.hostId);
    await expect.poll(() => bob.host(connector.hostId)).toBeUndefined();
    await expect.poll(() => bob.terminal(terminalId)).toBeUndefined();
  });

  it("참여자가 재접속하는 동안 실행 중인 PTY는 계속되어 이후 출력을 받는다", async () => {
    await using fixture = await controlledTerminalFixture(["alice"], {
      policy: { participantGraceMs: 3_000 },
    });
    const { terminalId } = fixture;
    const { alice } = fixture.participants;

    await runUntilOutput(
      alice,
      terminalId,
      ["export TTYROOM_E2E_SENTINEL=pty-'survived'", printMarker("state-set")].join("\n"),
      "state-set",
    );

    alice.close();
    await alice.reconnect();
    alice.sendInput(terminalId, "printf '%s\\n' \"$TTYROOM_E2E_SENTINEL\"\n");

    await assertOutputContains(alice, terminalId, "pty-survived");
    await assertTerminalState(alice, terminalId, { status: "open" });
  });

  it("재접속 replay의 실제 수신 프레임은 중복 없이 순서대로 도착한다", async () => {
    await using fixture = await outputHistoryFixture("unique-replay-marker", {
      policy: { participantGraceMs: 3_000 },
    });
    const { terminalId } = fixture;
    const { alice } = fixture.participants;

    alice.close();
    await alice.reconnect();

    await assertReplayExactlyOnce(alice, terminalId, "unique-replay-marker");
  });
});

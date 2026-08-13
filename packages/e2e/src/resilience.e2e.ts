import { describe, expect, it } from "vitest";
import { given, waitUntil } from "./harness.js";

describe("회복 탄력성 — 단절과 유예", () => {
  it("서버 재시작 뒤 같은 PTY·terminalId·공유 상태를 복원하고 단절 중 출력을 replay한다", async () => {
    await using server = await given.server({ hostGraceMs: 3_000 });
    const room = await server.room("Restart Safe");
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice", "stable-alice");
    const terminalId = await alice.openTerminal(agent.hostId);
    await alice.acquire(terminalId);
    await alice.rename(terminalId, "API logs");
    await alice.updateGeometry(terminalId, { x: 120, y: 80, width: 720, height: 480 });
    alice.type(
      terminalId,
      "export TTYROOM_RESTART_SENTINEL=pty-survived; (sleep 0.2; printf 'offline-output-marker\\n') & printf 'restart-armed\\n'\n",
    );
    await waitUntil(() => alice.outputText(terminalId).includes("restart-armed"));

    await server.restart(500);
    await alice.reconnect();
    await waitUntil(
      () =>
        alice.snapshot().hosts.some((host) => host.hostId === agent.hostId && host.online) &&
        alice.outputText(terminalId).includes("offline-output-marker"),
      {
        failure: () =>
          `복구 상태=${JSON.stringify(alice.snapshot())}\n출력=${alice.outputText(terminalId)}\n메시지=${JSON.stringify(alice.lastMessages().slice(-10))}`,
      },
    );

    const restored = alice
      .snapshot()
      .terminals.find((terminal) => terminal.terminalId === terminalId);
    expect(restored).toMatchObject({
      title: "API logs",
      geometry: { x: 120, y: 80, width: 720, height: 480 },
      status: "open",
    });
    expect(alice.snapshot().leases).toEqual([]);

    expect(await alice.acquire(terminalId)).toMatchObject({ kind: "granted" });
    alice.type(terminalId, "printf '%s\\n' \"$TTYROOM_RESTART_SENTINEL\"\n");
    await waitUntil(() => alice.outputText(terminalId).includes("pty-survived"));
  });

  it("참여자가 유예 내 같은 clientId로 재접속하면 임대가 유지된다", async () => {
    await using server = await given.server({ participantGraceMs: 3_000 });
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice", "stable-alice");
    const terminalId = await alice.openTerminal(agent.hostId);
    expect(await alice.acquire(terminalId)).toMatchObject({ kind: "granted" });

    alice.close();
    await alice.reconnect();

    await waitUntil(() =>
      alice
        .snapshot()
        .leases.some(
          (lease) => lease.terminalId === terminalId && lease.holderClientId === "stable-alice",
        ),
    );
  });

  it("agent 프로세스 종료는 host-offline을 알리고 유예 뒤 host와 터미널을 제거한다", async () => {
    await using server = await given.server({ hostGraceMs: 100 });
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const bob = await given.participant(room, "bob");
    const terminalId = await bob.openTerminal(agent.hostId);

    agent.kill();

    await waitUntil(
      () => bob.snapshot().hosts.find((host) => host.hostId === agent.hostId)?.online === false,
    );
    await waitUntil(
      () =>
        !bob.snapshot().hosts.some((host) => host.hostId === agent.hostId) &&
        !bob.snapshot().terminals.some((terminal) => terminal.terminalId === terminalId),
    );
  });

  it("브라우저가 재접속하는 동안 실행 중인 PTY는 계속되어 이후 출력을 받는다", async () => {
    await using server = await given.server({ participantGraceMs: 3_000 });
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice", "stable-alice");
    const terminalId = await alice.openTerminal(agent.hostId);
    await alice.acquire(terminalId);

    alice.type(terminalId, "export TTYROOM_E2E_SENTINEL=pty-survived; printf 'state-set\\n'\n");
    await waitUntil(() => alice.outputText(terminalId).includes("state-set"));
    alice.close();
    await alice.reconnect();
    alice.type(terminalId, "printf '%s\\n' \"$TTYROOM_E2E_SENTINEL\"\n");

    await waitUntil(() => alice.outputText(terminalId).includes("pty-survived"));
    expect(alice.snapshot().terminals).toContainEqual(
      expect.objectContaining({ terminalId, status: "open" }),
    );
  });

  it("재접속 replay는 이미 받은 seq를 transcript에 중복 추가하지 않는다", async () => {
    await using server = await given.server({ participantGraceMs: 3_000 });
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice", "stable-alice");
    const terminalId = await alice.openTerminal(agent.hostId);
    await alice.acquire(terminalId);
    alice.type(terminalId, "printf 'unique-replay-marker\\n'\n");
    await waitUntil(() => countOf(alice.outputText(terminalId), "unique-replay-marker") === 1);

    alice.close();
    await alice.reconnect();
    await waitUntil(() => alice.syncedSeq(terminalId) > 0);

    expect(countOf(alice.outputText(terminalId), "unique-replay-marker")).toBe(1);
  });
});

function countOf(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

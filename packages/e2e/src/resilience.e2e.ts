import { describe, expect, it } from "vitest";
import { given, waitUntil } from "./harness.js";

describe("회복 탄력성 — 단절과 유예", () => {
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

    alice.type(terminalId, "printf 'tick-1\\n'; sleep 0.2; printf 'tick-2\\n'\n");
    await waitUntil(() => alice.outputText(terminalId).includes("tick-1"));
    alice.close();
    await alice.reconnect();

    await waitUntil(() => alice.outputText(terminalId).includes("tick-2"));
    expect(alice.snapshot().terminals).toContainEqual(
      expect.objectContaining({ terminalId, status: "open" }),
    );
  });
});

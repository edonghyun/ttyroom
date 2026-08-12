import { describe, expect, it } from "vitest";
import { given, waitUntil } from "./harness.js";

describe("협업 플로우 — A 입력을 B가 본다", () => {
  it("참여자 A가 agent 터미널에 입력하면 A와 B 화면에 출력이 도착한다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice");
    const bob = await given.participant(room, "bob");

    const terminalId = await alice.openTerminal(agent.hostId);
    const lease = await alice.acquire(terminalId);
    expect(lease.kind).toBe("granted");

    alice.type(terminalId, "echo collab-ok\n");

    await waitUntil(() => bob.outputText(terminalId).includes("collab-ok"));
    await waitUntil(() => alice.outputText(terminalId).includes("collab-ok"));
  });

  it("늦게 합류한 참여자는 기존 출력과 마지막 seq를 replay로 받는다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice");
    const terminalId = await alice.openTerminal(agent.hostId);
    await alice.acquire(terminalId);
    alice.type(terminalId, "echo before-carol\n");
    await waitUntil(() => alice.outputText(terminalId).includes("before-carol"));

    const carol = await given.participant(room, "carol");

    await waitUntil(() => carol.outputText(terminalId).includes("before-carol"));
    await waitUntil(() => carol.syncedSeq(terminalId) > 0);
  });

  it("점유된 터미널의 acquire는 denied와 현재 소유자를 돌려준다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice", "alice-id");
    const bob = await given.participant(room, "bob", "bob-id");
    const terminalId = await alice.openTerminal(agent.hostId);
    expect(await alice.acquire(terminalId)).toMatchObject({ kind: "granted" });

    expect(await bob.acquire(terminalId)).toEqual({
      kind: "denied",
      holderClientId: "alice-id",
    });
  });
});

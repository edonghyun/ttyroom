import { describe, expect, it } from "vitest";
import { given, waitUntil } from "./harness.js";

describe("협업 플로우 — A 입력을 B가 본다", () => {
  it("이름을 붙여 만든 Room은 welcome snapshot에서 같은 표시 이름을 제공한다", async () => {
    await using server = await given.server();
    const room = await server.room("Payment Debug");
    const alice = await given.participant(room, "alice");

    expect(room.name).toBe("Payment Debug");
    expect(alice.snapshot().name).toBe("Payment Debug");
  });

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

  it("output-gap 뒤 participant가 terminal 단위 resync를 요청하면 scrollback과 sync를 다시 받는다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice");
    const terminalId = await alice.openTerminal(agent.hostId);
    await alice.acquire(terminalId);
    alice.type(terminalId, "echo replay-on-demand\n");
    await waitUntil(() => alice.outputText(terminalId).includes("replay-on-demand"));

    await alice.resyncOutput(terminalId);

    expect(alice.outputText(terminalId)).toContain("replay-on-demand");
    expect(alice.syncedSeq(terminalId)).toBeGreaterThan(0);
  });

  it("participant가 terminal mode를 명시적으로 shared로 바꾸면 snapshot projection이 갱신된다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice");
    const terminalId = await alice.openTerminal(agent.hostId);

    await alice.setMode(terminalId, "shared");

    expect(
      alice.snapshot().terminals.find((terminal) => terminal.terminalId === terminalId)?.mode,
    ).toBe("shared");
  });

  it("participant close 요청은 Agent가 PTY를 닫은 뒤 exited snapshot으로 확정된다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice");
    const terminalId = await alice.openTerminal(agent.hostId);

    await alice.closeTerminal(terminalId);

    expect(
      alice.snapshot().terminals.find((terminal) => terminal.terminalId === terminalId),
    ).toMatchObject({ status: "exited" });
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

  it("서로 다른 host의 동시 open 응답은 요청한 host의 terminal로 각각 상관한다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const hostA = await given.agent(room, "host-a");
    const hostB = await given.agent(room, "host-b");
    const alice = await given.participant(room, "alice");
    const bob = await given.participant(room, "bob");

    const [terminalA, terminalB] = await Promise.all([
      alice.openTerminal(hostA.hostId),
      bob.openTerminal(hostB.hostId),
    ]);

    expect(
      alice.snapshot().terminals.find((terminal) => terminal.terminalId === terminalA)?.hostId,
    ).toBe(hostA.hostId);
    expect(
      bob.snapshot().terminals.find((terminal) => terminal.terminalId === terminalB)?.hostId,
    ).toBe(hostB.hostId);
  });

  it("동시에 연결한 두 agent handle은 요청한 표시 이름의 host를 각각 가리킨다", async () => {
    await using server = await given.server();
    const room = await server.room();

    const [hostA, hostB] = await Promise.all([
      given.agent(room, "concurrent-a"),
      given.agent(room, "concurrent-b"),
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

  it("표시 이름이 같은 agent를 동시에 연결해도 서로 다른 handle을 돌려준다", async () => {
    await using server = await given.server();
    const room = await server.room();

    const [hostA, hostB] = await Promise.all([
      given.agent(room, "duplicate-name"),
      given.agent(room, "duplicate-name"),
    ]);

    expect(hostA.hostId).not.toBe(hostB.hostId);
  });

  it("한 참여자의 같은 host 동시 open은 서로 다른 terminalId로 완료된다", async () => {
    await using server = await given.server();
    const room = await server.room();
    const host = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice");

    const terminalIds = await Promise.all([
      alice.openTerminal(host.hostId),
      alice.openTerminal(host.hostId),
    ]);

    expect(new Set(terminalIds).size).toBe(2);
  });
});

import { encodeDataFrame } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { protocolWorkspaceFixture } from "./protocol-fixture.js";
import type { SocketProbe } from "./socket-probe.js";

async function request(peer: SocketProbe, command: unknown) {
  peer.send(command);
  return peer.next();
}

/** Stored workspace plus transient state; raw peers never auto-reconnect after restart. */
async function storedWorkspaceFixture() {
  const fixture = await protocolWorkspaceFixture([7, 8]);
  try {
    const { observer, host } = fixture;
    await request(observer, { type: "rename-terminal", terminalId: 7, title: "API logs" });
    await request(observer, {
      type: "update-terminal-geometry",
      terminalId: 7,
      geometry: { x: -12.5, y: 80, width: 720, height: 480 },
    });
    await request(observer, { type: "set-terminal-mode", terminalId: 7, mode: "shared" });
    host.send({
      type: "terminal-meta",
      terminalId: 7,
      meta: { cwd: "/work", gitBranch: "main", fgProcess: "sh" },
    });
    await observer.next();
    host.send({ type: "host-input-state", remoteInputAllowed: true });
    await observer.next();
    const acquired = await request(observer, { type: "acquire-lease", terminalId: 8 });
    if (acquired.type !== "lease-result" || acquired.result.kind !== "granted")
      throw new Error("Persistence fixture requires a lease to prove restart clears it");
    await observer.next();
    await request(observer, { type: "focus-terminal", terminalId: 7 });
    host.send({ type: "terminal-closed", terminalId: 8, exitCode: 9 });
    await observer.next();
    host.sendBytes(
      encodeDataFrame({
        kind: "output",
        terminalId: 7,
        seq: 1,
        payload: Buffer.from("not-stored-output"),
      }),
    );
    const output = await observer.nextPacket();
    if (output.kind !== "binary") throw new Error("Expected output before restart");
    const before = (await fixture.join("before", "participant")).welcome.snapshot;
    return { ...fixture, before };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

describe("영속 저장 계약 — Node·Spring 공통", () => {
  it("새 PID에서도 초대·workspace는 복원하고 presence·lease·출력은 초기화한다", async () => {
    await using fixture = await storedWorkspaceFixture();
    const previousPid = fixture.server.processId;

    await fixture.server.restart();
    const restored = await fixture.join("alice", "participant");
    const outputBoundary = await restored.peer.next();
    const noOldOutput = await request(restored.peer, {
      type: "acquire-lease",
      terminalId: 0xfffffffe,
    });

    expect(fixture.server.processId).not.toBe(previousPid);
    expect(restored.welcome.snapshot).toEqual({
      roomId: fixture.before.roomId,
      name: fixture.before.name,
      participants: [{ clientId: "alice", name: "alice", focusedTerminalId: null }],
      hosts: [{ hostId: "host", name: "host", online: false, remoteInputAllowed: false }],
      terminals: fixture.before.terminals,
      leases: [],
    });
    expect(outputBoundary).toEqual({ type: "sync", terminalId: 7, seq: 0 });
    expect(noOldOutput).toMatchObject({ type: "lease-invalid", terminalId: 0xfffffffe });
  });

  it("재시작 후 같은 runtime은 열린 터미널로 복원하고 replay 위치를 전달한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    await fixture.server.restart();
    const host = (await fixture.join("host", "host")).peer;
    const ready = await announceRuntime(host, "runtime-7");
    const after = (await fixture.join("after", "participant")).welcome.snapshot;

    expect(ready).toEqual({
      type: "host-ready",
      terminals: [{ terminalId: 7, replayAfterSeq: 0 }],
    });
    expect(after.terminals[0]).toMatchObject({ status: "open", exitCode: null });
  });

  it("재시작 후 충돌한 runtime은 종료를 요청하고 복구 목록에서 제외한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    await fixture.server.restart();
    const host = (await fixture.join("host", "host")).peer;
    const close = await announceRuntime(host, "conflicting-runtime");
    const ready = await host.next();
    const after = (await fixture.join("after", "participant")).welcome.snapshot;

    expect(close).toEqual({ type: "close-terminal", terminalId: 7 });
    expect(ready).toEqual({ type: "host-ready", terminals: [] });
    expect(after.terminals[0]).toMatchObject({ status: "exited", exitCode: null });
  });

  it("확인 전 예약과 다음 ID를 복원해 재시작 뒤 ID를 재사용하지 않는다", async () => {
    await using fixture = await protocolWorkspaceFixture();
    fixture.observer.send({ type: "open-terminal-request", hostId: "host" });
    const reserved = await fixture.host.next();
    if (reserved.type !== "open-terminal") throw new Error("Expected reservation");
    await request(fixture.observer, {
      type: "rename-terminal",
      terminalId: reserved.terminalId,
      title: "pending",
    });

    await fixture.server.restart();
    const host = (await fixture.join("host", "host")).peer;
    const restored = await fixture.join("after", "participant");
    await restored.peer.next(); // Empty-history sync for the restored pending terminal.
    restored.peer.send({ type: "open-terminal-request", hostId: "host" });
    const next = await host.next();

    expect(restored.welcome.snapshot.terminals).toMatchObject([
      { terminalId: reserved.terminalId, title: "pending", status: "open" },
    ]);
    expect(next).toMatchObject({ type: "open-terminal", terminalId: reserved.terminalId + 1 });
  });
});

function announceRuntime(host: SocketProbe, runtimeId: string) {
  return request(host, {
    type: "host-inventory",
    terminals: [{ terminalId: 7, runtimeId, firstRetainedSeq: 0, lastOutputSeq: 0 }],
  });
}

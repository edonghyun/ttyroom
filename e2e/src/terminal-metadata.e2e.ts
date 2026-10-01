import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { protocolWorkspaceFixture } from "./protocol-fixture.js";
import type { SocketProbe } from "@ttyroom/test-support/socket-probe";
import { terminalFixture } from "./fixtures.js";
import { given, waitUntil } from "./harness.js";

const emptyMeta = { cwd: null, gitBranch: null, fgProcess: null };
const metadata = { cwd: "/workspace/한글", gitBranch: "feature/example", fgProcess: "sh" };
function reportMetadata(sender: SocketProbe, meta: unknown = metadata, terminalId = 7) {
  sender.send({ type: "terminal-meta", terminalId, meta });
}

describe("Terminal 메타데이터 — Node/Spring 공통", () => {
  it("변경만 순서대로 발행하고 null 초기화도 늦은 참여자 snapshot에 반영한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    reportMetadata(fixture.host, emptyMeta);
    reportMetadata(fixture.host, metadata);
    reportMetadata(fixture.host, { ...metadata });
    reportMetadata(fixture.host, emptyMeta);
    const events = await fixture.captureThroughInputCycle();
    const { welcome } = await fixture.join("late", "participant");

    expect(events).toEqual([
      { type: "room-event", event: { kind: "terminal-meta", terminalId: 7, meta: metadata } },
      { type: "room-event", event: { kind: "terminal-meta", terminalId: 7, meta: emptyMeta } },
      {
        type: "room-event",
        event: { kind: "host-input-state-changed", hostId: "host", remoteInputAllowed: true },
      },
    ]);
    expect(welcome.snapshot.terminals).toMatchObject([{ terminalId: 7, meta: emptyMeta }]);
  });

  it("빈 문자열은 값으로 보존하고 알 수 없는 필드는 제거한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const meta = { cwd: "", gitBranch: "", fgProcess: "" };

    reportMetadata(fixture.host, { ...meta, privateField: "ignored" });
    const event = await fixture.observer.next();
    const { welcome } = await fixture.join("late", "participant");

    expect(event).toEqual({
      type: "room-event",
      event: { kind: "terminal-meta", terminalId: 7, meta },
    });
    expect(welcome.snapshot.terminals[0]?.meta).toEqual(meta);
  });

  it("종료 직후 늦은 보고는 종료 상태와 코드를 유지한 채 메타데이터만 갱신한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    fixture.host.send({ type: "terminal-closed", terminalId: 7, exitCode: 7 });
    await fixture.observer.next();

    reportMetadata(fixture.host);
    const event = await fixture.observer.next();
    const { welcome } = await fixture.join("late", "participant");

    expect(event).toMatchObject({
      event: { kind: "terminal-meta", terminalId: 7, meta: metadata },
    });
    expect(welcome.snapshot.terminals).toMatchObject([
      { terminalId: 7, status: "exited", exitCode: 7, meta: metadata },
    ]);
  });

  it.each(["participant", "foreign-host", "unknown-terminal"] as const)(
    "%s 보고는 소유한 터미널 상태를 바꾸지 않는다",
    async (source) => {
      await using fixture = await protocolWorkspaceFixture([7]);
      let sender = fixture.host;
      if (source === "participant") sender = fixture.observer;
      else if (source === "foreign-host") sender = (await fixture.join("other", "host")).peer;

      reportMetadata(sender, metadata, source === "unknown-terminal" ? 99 : 7);
      const rejection = await sender.next();
      const { welcome } = await fixture.join("late", "participant");

      expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
      expect(welcome.snapshot.terminals).toMatchObject([{ terminalId: 7, meta: emptyMeta }]);
    },
  );

  it.each([
    { name: "null", meta: null },
    { name: "배열", meta: [] },
    { name: "빈 객체", meta: {} },
    { name: "필드 누락", meta: { cwd: null, gitBranch: null } },
    { name: "숫자 cwd", meta: { ...emptyMeta, cwd: 1 } },
    { name: "boolean 브랜치", meta: { ...emptyMeta, gitBranch: false } },
    { name: "객체 프로세스명", meta: { ...emptyMeta, fgProcess: {} } },
  ])("$name 보고를 거절한 뒤에도 유효한 보고를 처리한다", async ({ meta }) => {
    await using fixture = await protocolWorkspaceFixture([7]);

    reportMetadata(fixture.host, meta);
    const rejection = await fixture.host.next();
    reportMetadata(fixture.host);
    const event = await fixture.observer.next();

    expect(rejection).toMatchObject({ type: "error", code: "bad-message" });
    expect(event).toMatchObject({
      event: { kind: "terminal-meta", terminalId: 7, meta: metadata },
    });
  });

  it("실제 Connector는 PTY 메타데이터 보고 후에도 다음 PTY를 생성한다", async () => {
    await using fixture = await terminalFixture(["alice"]);
    const { alice } = fixture.participants;
    const expectedCwd = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));

    await waitUntil(() => alice.terminal(fixture.terminalId)?.meta.cwd === expectedCwd, {
      timeoutMs: 20_000,
      failure: () => `PTY metadata missing: ${JSON.stringify(alice.terminal(fixture.terminalId))}`,
    });
    const second = await alice.openTerminal(fixture.connector.hostId);
    const late = await given.participant(fixture.room, "late");

    expect(second).not.toBe(fixture.terminalId);
    expect(late.terminal(fixture.terminalId)).toMatchObject({
      status: "open",
      meta: { cwd: expectedCwd },
    });
    expect(late.terminal(second)).toMatchObject({
      status: "open",
      hostId: fixture.connector.hostId,
    });
    expect(late.host(fixture.connector.hostId)?.online).toBe(true);
  });
});

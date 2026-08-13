import { describe, expect, it } from "vitest";
import { Room, type AcquireDecision } from "./room.js";

const makeRoom = () => new Room({ roomId: "r1", token: "tok" });

function givenConnectedHost(hostId = "h1", name = "동현-Mac"): Room {
  const room = makeRoom();
  room.connectHost(hostId, name);
  return room;
}

function givenOpenTerminal(): { room: Room; terminalId: number } {
  const room = givenConnectedHost("h1", "h");
  return { room, terminalId: room.openTerminal("h1").terminalId };
}

function grantedLeaseId(decision: AcquireDecision): number {
  if (decision.kind !== "granted") throw new Error("임대가 granted되지 않았다");
  return decision.lease.leaseId;
}

describe("Room — 역할: Room 라이브 상태와 불변식의 소유자", () => {
  it("내구 레코드로 복원하면 Room·터미널은 유지하고 presence·lease는 초기화한다", () => {
    const room = new Room({ roomId: "r1", token: "tok", name: "Payment Debug" });
    room.connectHost("h1", "동현-Mac");
    room.addParticipant("c1", "동현");
    const terminal = room.openTerminal("h1");
    room.confirmTerminalOpened(terminal.terminalId, "runtime-1");
    room.renameTerminal(terminal.terminalId, "API logs");
    room.updateTerminalGeometry(terminal.terminalId, {
      x: 120,
      y: 80,
      width: 720,
      height: 480,
    });
    room.acquireLease("c1", terminal.terminalId);

    const restored = Room.restore(room.record());

    expect(restored.matchesToken("tok")).toBe(true);
    expect(restored.matchesToken("wrong")).toBe(false);
    expect(restored.snapshot()).toMatchObject({
      roomId: "r1",
      name: "Payment Debug",
      participants: [],
      leases: [],
      hosts: [
        {
          hostId: "h1",
          name: "동현-Mac",
          online: false,
          remoteInputAllowed: false,
        },
      ],
      terminals: [
        {
          terminalId: terminal.terminalId,
          title: "API logs",
          geometry: { x: 120, y: 80, width: 720, height: 480 },
          status: "open",
        },
      ],
    });
    expect(restored.terminalRuntimeId(terminal.terminalId)).toBe("runtime-1");

    restored.connectHost("h1", "동현-Mac");
    expect(restored.openTerminal("h1").terminalId).toBe(2);
  });

  it("내구 레코드에는 Room token 원문 대신 digest만 저장한다", () => {
    const record = makeRoom().record();

    expect(record).not.toHaveProperty("token");
    expect(record).toMatchObject({ tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("Agent inventory로 기존 PTY를 복구하고 누락·Agent-only PTY를 명시적으로 조정한다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    const kept = room.openTerminal("h1");
    room.confirmTerminalOpened(kept.terminalId, "runtime-kept");
    const missing = room.openTerminal("h1");
    room.confirmTerminalOpened(missing.terminalId, "runtime-missing");

    const result = room.reconcileHostTerminals("h1", [
      { terminalId: kept.terminalId, runtimeId: "runtime-kept" },
      { terminalId: 7, runtimeId: "runtime-recovered" },
    ]);

    expect(result.activeTerminalIds).toEqual([kept.terminalId, 7]);
    expect(result.closedTerminalIds).toEqual([missing.terminalId]);
    expect(result.recoveredTerminals).toMatchObject([{ terminalId: 7, hostId: "h1" }]);
    expect(room.terminal(missing.terminalId)).toMatchObject({ status: "exited" });
    expect(room.terminalRuntimeId(7)).toBe("runtime-recovered");
    expect(room.snapshot().hosts).toMatchObject([
      { hostId: "h1", online: true, remoteInputAllowed: false },
    ]);
    expect(room.openTerminal("h1").terminalId).toBe(8);
  });

  it("동일 terminalId의 runtime이 충돌하면 서버 상태를 종료하고 Agent PTY도 닫도록 반환한다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    const terminal = room.openTerminal("h1");
    room.confirmTerminalOpened(terminal.terminalId, "runtime-before-restart");

    const result = room.reconcileHostTerminals("h1", [
      { terminalId: terminal.terminalId, runtimeId: "different-runtime" },
    ]);

    expect(result.activeTerminalIds).toEqual([]);
    expect(result.closedTerminalIds).toEqual([terminal.terminalId]);
    expect(result.agentTerminalIdsToClose).toEqual([terminal.terminalId]);
    expect(room.terminal(terminal.terminalId)).toMatchObject({ status: "exited" });
  });

  it("이미 종료된 terminalId를 Agent가 보고하면 고아로 두지 않고 닫도록 반환한다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    const terminal = room.openTerminal("h1");
    room.confirmTerminalOpened(terminal.terminalId, "runtime-1");
    room.markTerminalExited(terminal.terminalId, 0);

    const result = room.reconcileHostTerminals("h1", [
      { terminalId: terminal.terminalId, runtimeId: "runtime-still-alive" },
    ]);

    expect(result.agentTerminalIdsToClose).toEqual([terminal.terminalId]);
    expect(result.recoveredTerminals).toEqual([]);
  });

  it("Room 표시 이름은 스냅샷에 포함되고 미지정 시 안전한 기본값을 사용한다", () => {
    const named = new Room({ roomId: "named", token: "tok", name: "Payment Debug" });

    expect(named.snapshot().name).toBe("Payment Debug");
    expect(makeRoom().snapshot().name).toBe("Quick Room");
  });

  it("참여자를 추가하면 스냅샷에 나타난다", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    expect(room.snapshot().participants).toEqual([
      { clientId: "c1", name: "동현", focusedTerminalId: null },
    ]);
  });

  it("같은 clientId로 다시 추가하면 중복 없이 이름만 갱신된다 (재접속 멱등)", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    room.addParticipant("c1", "동현2");
    expect(room.snapshot().participants).toEqual([
      { clientId: "c1", name: "동현2", focusedTerminalId: null },
    ]);
  });

  it("Host 연결 후 openTerminal은 증가하는 terminalId로 exclusive 터미널을 만든다", () => {
    const room = givenConnectedHost();
    const t1 = room.openTerminal("h1");
    const t2 = room.openTerminal("h1");
    expect([t1.terminalId, t2.terminalId]).toEqual([1, 2]);
    expect(t1).toMatchObject({ hostId: "h1", mode: "exclusive", status: "open", exitCode: null });
  });

  it("새 터미널은 Room이 결정한 겹치지 않는 공유 geometry로 열린다", () => {
    const room = givenConnectedHost();

    const first = room.openTerminal("h1");
    const second = room.openTerminal("h1");

    expect(first.geometry).toEqual({ x: 24, y: 24, width: 640, height: 420 });
    expect(second.geometry).toEqual({ x: 56, y: 56, width: 640, height: 420 });
  });

  it("없는 Host에 openTerminal하면 throw한다 (프로그래머 오류)", () => {
    expect(() => makeRoom().openTerminal("nope")).toThrow();
  });

  it("Host를 offline으로 표시해도 터미널은 스냅샷에 남는다", () => {
    const room = givenConnectedHost();
    room.openTerminal("h1");
    room.markHostOffline("h1");
    expect(room.snapshot().hosts).toEqual([
      { hostId: "h1", name: "동현-Mac", online: false, remoteInputAllowed: true },
    ]);
    expect(room.snapshot().terminals).toHaveLength(1);
  });

  it("Host 원격 입력은 처음 허용되고 kill switch 보고로 snapshot 상태가 바뀐다", () => {
    const room = givenConnectedHost();
    expect(room.snapshot().hosts).toMatchObject([{ hostId: "h1", remoteInputAllowed: true }]);

    room.setHostRemoteInputAllowed("h1", false);

    expect(room.snapshot().hosts).toMatchObject([{ hostId: "h1", remoteInputAllowed: false }]);
  });

  it("removeHost는 host와 그 터미널을 제거하고 terminalId 목록을 돌려준다", () => {
    const room = givenConnectedHost();
    const t = room.openTerminal("h1");
    expect(room.removeHost("h1")).toEqual([t.terminalId]);
    expect(room.snapshot().hosts).toEqual([]);
    expect(room.snapshot().terminals).toEqual([]);
  });

  it("removeHost 후 새로 연 터미널은 제거된 terminalId를 재사용하지 않는다 (lease·frame 라우팅 안전)", () => {
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t1 = room.openTerminal("h1");
    room.removeHost("h1");
    room.connectHost("h2", "h2");
    const t2 = room.openTerminal("h2");
    expect(t2.terminalId).toBeGreaterThan(t1.terminalId);
  });

  it("markTerminalExited는 상태만 바꾸고 터미널을 제거하지 않는다", () => {
    const { room, terminalId } = givenOpenTerminal();

    room.markTerminalExited(terminalId, 0);

    expect(room.terminal(terminalId)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("참여자와 온라인 host가 모두 없으면 isEmpty가 참이다 (Quick Room 소멸 조건)", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    room.connectHost("h1", "h");
    expect(room.isEmpty()).toBe(false);
    room.removeParticipant("c1");
    room.markHostOffline("h1");
    expect(room.isEmpty()).toBe(true);
  });

  it("없는 참여자 제거는 조용한 no-op이다 (유예 만료·명시적 leave 중복 도착 안전)", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    room.removeParticipant("c1");
    expect(() => room.removeParticipant("c1")).not.toThrow();
    expect(room.snapshot().participants).toEqual([]);
  });

  it("hasParticipant는 참여 중일 때만 참이다", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    expect(room.hasParticipant("c1")).toBe(true);
    room.removeParticipant("c1");
    expect(room.hasParticipant("c1")).toBe(false);
  });

  it("offline host가 같은 hostId로 다시 연결하면 중복 없이 online으로 복귀한다 (재접속 멱등)", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    room.markHostOffline("h1");
    room.connectHost("h1", "동현-Mac-2");
    expect(room.snapshot().hosts).toEqual([
      { hostId: "h1", name: "동현-Mac-2", online: true, remoteInputAllowed: true },
    ]);
  });

  it("host 재접속(connectHost 재호출)은 그 host의 기존 터미널을 보존한다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    const t = room.openTerminal("h1");
    room.markHostOffline("h1");
    room.connectHost("h1", "동현-Mac");
    expect(room.terminal(t.terminalId)).toMatchObject({ hostId: "h1", status: "open" });
  });

  it("setTerminalMode는 터미널 모드를 shared로 전환한다", () => {
    const { room, terminalId } = givenOpenTerminal();

    room.setTerminalMode(terminalId, "shared");

    expect(room.terminal(terminalId)).toMatchObject({ mode: "shared" });
  });

  it("없는 터미널에 setTerminalMode하면 throw한다 (프로그래머 오류)", () => {
    expect(() => makeRoom().setTerminalMode(99, "shared")).toThrow();
  });

  it("updateTerminalMeta는 터미널의 meta를 갱신해 스냅샷에 반영한다", () => {
    const { room, terminalId } = givenOpenTerminal();

    room.updateTerminalMeta(terminalId, {
      cwd: "/repo",
      gitBranch: "main",
      fgProcess: "vim",
    });

    expect(room.terminal(terminalId)?.meta).toEqual({
      cwd: "/repo",
      gitBranch: "main",
      fgProcess: "vim",
    });
  });

  it("updateTerminalGeometry는 마지막 갱신을 snapshot의 공유 배치로 보존한다", () => {
    const { room, terminalId } = givenOpenTerminal();
    const aliceGeometry = { x: 140, y: 90, width: 700, height: 460 };
    const bobGeometry = { x: 260, y: 120, width: 760, height: 520 };

    room.updateTerminalGeometry(terminalId, aliceGeometry);
    room.updateTerminalGeometry(terminalId, bobGeometry);

    expect(room.snapshot().terminals[0]?.geometry).toEqual(bobGeometry);
  });

  it("renameTerminal은 마지막 이름을 snapshot에 보존하고 같은 이름은 unchanged로 판정한다", () => {
    const { room, terminalId } = givenOpenTerminal();

    expect(room.renameTerminal(terminalId, "API logs")).toBe(true);
    expect(room.renameTerminal(terminalId, "API logs")).toBe(false);

    expect(room.snapshot().terminals[0]?.title).toBe("API logs");
  });

  it("openTerminal이 돌려준 뷰를 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const room = givenConnectedHost("h1", "h");

    const created = room.openTerminal("h1");
    created.status = "exited";
    created.meta.cwd = "/oops";

    expect(room.terminal(created.terminalId)).toMatchObject({
      status: "open",
      meta: { cwd: null },
    });
  });

  it("terminal()이 돌려준 뷰를 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const { room, terminalId } = givenOpenTerminal();
    const view = room.terminal(terminalId);
    if (!view) throw new Error("열린 터미널을 조회할 수 없다");
    view.mode = "shared";
    view.meta.cwd = "/oops";

    expect(room.terminal(terminalId)).toMatchObject({
      mode: "exclusive",
      meta: { cwd: null },
    });
  });

  it("스냅샷을 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const { room, terminalId } = givenOpenTerminal();
    const snap = room.snapshot();
    const terminal = snap.terminals[0];
    if (!terminal) throw new Error("스냅샷에 열린 터미널이 없다");
    terminal.status = "exited";
    terminal.meta.cwd = "/oops";

    expect(room.terminal(terminalId)).toMatchObject({
      status: "open",
      meta: { cwd: null },
    });
  });
});

describe("Room participant focus — 역할: 참가자가 보고한 현재 터미널의 단일 진실", () => {
  const withParticipantAndTerminal = () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    room.connectHost("h1", "Mac");
    const terminal = room.openTerminal("h1");
    return { room, terminal };
  };

  it("존재하는 terminal focus와 blur를 snapshot에 반영한다", () => {
    const { room, terminal } = withParticipantAndTerminal();

    expect(room.focusParticipant("c1", terminal.terminalId)).toBe("changed");
    expect(room.snapshot().participants[0]).toMatchObject({
      focusedTerminalId: terminal.terminalId,
    });

    expect(room.focusParticipant("c1", null)).toBe("changed");
    expect(room.snapshot().participants[0]).toMatchObject({ focusedTerminalId: null });
  });

  it("같은 focus 재보고는 unchanged이고 재접속 이름 갱신 중 focus를 보존한다", () => {
    const { room, terminal } = withParticipantAndTerminal();
    room.focusParticipant("c1", terminal.terminalId);

    expect(room.focusParticipant("c1", terminal.terminalId)).toBe("unchanged");
    room.addParticipant("c1", "동현2");

    expect(room.snapshot().participants[0]).toEqual({
      clientId: "c1",
      name: "동현2",
      focusedTerminalId: terminal.terminalId,
    });
  });

  it("미등록 참가자는 throw하고 없는 terminal focus는 rejected한다", () => {
    const { room } = withParticipantAndTerminal();

    expect(() => room.focusParticipant("stranger", null)).toThrow();
    expect(room.focusParticipant("c1", 999)).toBe("rejected");
    expect(room.snapshot().participants[0]).toMatchObject({ focusedTerminalId: null });
  });
});

describe("Room 입력권 임대 — 역할: 터미널 입력 권한의 단일 진실", () => {
  const withTerminal = () => {
    const room = makeRoom();
    room.addParticipant("alice", "A");
    room.addParticipant("bob", "B");
    room.connectHost("h1", "h");
    return { room, t: room.openTerminal("h1") };
  };

  it("빈 exclusive 터미널의 임대 요청은 granted된다", () => {
    const { room, t } = withTerminal();
    expect(room.acquireLease("alice", t.terminalId)).toMatchObject({
      kind: "granted",
      lease: { terminalId: t.terminalId, holderClientId: "alice" },
    });
  });

  it("이미 잡힌 터미널의 타인 요청은 denied되고 현재 소유자를 알려준다 (선착순)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);
    expect(room.acquireLease("bob", t.terminalId)).toEqual({
      kind: "denied",
      holderClientId: "alice",
    });
  });

  it("소유자의 같은 요청 재도착은 already-held로 멱등하다 (재전송 안전)", () => {
    const { room, t } = withTerminal();
    const first = room.acquireLease("alice", t.terminalId);
    const second = room.acquireLease("alice", t.terminalId);
    expect(second.kind).toBe("already-held");
    expect(room.snapshot().leases).toHaveLength(1);
    if (first.kind === "granted" && second.kind === "already-held")
      expect(second.lease.leaseId).toBe(first.lease.leaseId);
  });

  it("다른 터미널 획득 시 기존 임대는 자동 해제된다 (1인 1임대)", () => {
    const { room, t } = withTerminal();
    const t2 = room.openTerminal("h1");
    room.acquireLease("alice", t.terminalId);
    const d = room.acquireLease("alice", t2.terminalId);
    expect(d).toMatchObject({ kind: "granted", autoReleased: { terminalId: t.terminalId } });
    expect(room.leaseOf(t.terminalId)).toBeUndefined();
  });

  it("leaseOf가 돌려준 뷰를 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);

    room.leaseOf(t.terminalId)!.holderClientId = "mallory";

    expect(room.leaseOf(t.terminalId)).toMatchObject({ holderClientId: "alice" });
  });

  it("acquireLease가 돌려준 lease를 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const { room, t } = withTerminal();
    const d = room.acquireLease("alice", t.terminalId);

    if (d.kind !== "granted") throw new Error("전제 실패: granted여야 한다");
    d.lease.holderClientId = "mallory";

    expect(room.leaseOf(t.terminalId)).toMatchObject({ holderClientId: "alice" });
  });

  it("exited 터미널의 임대 요청은 rejected된다", () => {
    const { room, t } = withTerminal();
    room.markTerminalExited(t.terminalId, 0);
    expect(room.acquireLease("alice", t.terminalId)).toEqual({
      kind: "rejected",
      reason: "terminal-not-open",
    });
  });

  it("removeParticipant는 떠난 참여자의 임대를 걷어 반환한다 (stale lease 방지, removeHost와 대칭)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);

    expect(room.removeParticipant("alice")).toMatchObject([
      { terminalId: t.terminalId, holderClientId: "alice" },
    ]);

    expect(room.leaseOf(t.terminalId)).toBeUndefined();
    expect(room.snapshot().leases).toEqual([]);
  });

  it("참여자가 아닌 clientId의 임대 요청은 throw한다 (프로그래머 오류 — hello/등록은 유즈케이스가 보장)", () => {
    const { room, t } = withTerminal();
    expect(() => room.acquireLease("stranger", t.terminalId)).toThrow();
  });

  it("없는 터미널의 임대 요청은 rejected된다", () => {
    const { room } = withTerminal();
    expect(room.acquireLease("alice", 999)).toEqual({
      kind: "rejected",
      reason: "terminal-not-open",
    });
  });

  it("shared 터미널의 임대 요청은 rejected된다 (임대는 exclusive 전용)", () => {
    const { room, t } = withTerminal();
    room.setTerminalMode(t.terminalId, "shared");
    expect(room.acquireLease("alice", t.terminalId)).toEqual({
      kind: "rejected",
      reason: "shared-terminal",
    });
  });

  it("소유자가 아닌 release는 not-holder이고 상태를 바꾸지 않는다", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);
    expect(room.releaseLease("bob", t.terminalId)).toEqual({ kind: "not-holder" });
    expect(room.leaseOf(t.terminalId)).toMatchObject({ holderClientId: "alice" });
  });

  it("소유자의 release는 released로 임대를 해제한다", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);
    expect(room.releaseLease("alice", t.terminalId)).toMatchObject({
      kind: "released",
      lease: { terminalId: t.terminalId, holderClientId: "alice" },
    });
    expect(room.leaseOf(t.terminalId)).toBeUndefined();
    expect(room.snapshot().leases).toEqual([]);
  });

  it("releaseAllOf는 해당 사용자의 임대만 걷어 반환한다", () => {
    const { room, t } = withTerminal();
    const t2 = room.openTerminal("h1");
    room.acquireLease("alice", t.terminalId);
    room.acquireLease("bob", t2.terminalId);

    expect(room.releaseAllOf("alice")).toMatchObject([{ terminalId: t.terminalId }]);

    expect(room.leaseOf(t.terminalId)).toBeUndefined();
    expect(room.leaseOf(t2.terminalId)).toMatchObject({ holderClientId: "bob" });
  });

  it("isInputAllowed: exclusive는 유효 leaseId 일치일 때만 참이다", () => {
    const { room, t } = withTerminal();
    const leaseId = grantedLeaseId(room.acquireLease("alice", t.terminalId));
    expect(room.isInputAllowed("alice", t.terminalId, leaseId)).toBe(true);
    expect(room.isInputAllowed("alice", t.terminalId, leaseId + 99)).toBe(false);
    expect(room.isInputAllowed("bob", t.terminalId, leaseId)).toBe(false);
  });

  it("isInputAllowed: shared 터미널은 참여자면 임대 없이 참이다", () => {
    const { room, t } = withTerminal();
    room.setTerminalMode(t.terminalId, "shared");
    expect(room.isInputAllowed("bob", t.terminalId, 0)).toBe(true);
    expect(room.isInputAllowed("stranger", t.terminalId, 0)).toBe(false);
  });

  it("isInputAllowed: exited 터미널은 유효 임대 소유자라도 거짓이다", () => {
    const { room, t } = withTerminal();
    const leaseId = grantedLeaseId(room.acquireLease("alice", t.terminalId));
    room.markTerminalExited(t.terminalId, 0);
    expect(room.isInputAllowed("alice", t.terminalId, leaseId)).toBe(false);
  });

  it("release 후 재획득은 새 leaseId를 발급하고 이전 leaseId는 무효다 (leaseId 비재사용)", () => {
    const { room, t } = withTerminal();
    const firstId = grantedLeaseId(room.acquireLease("alice", t.terminalId));

    room.releaseLease("alice", t.terminalId);
    const secondId = grantedLeaseId(room.acquireLease("alice", t.terminalId));

    expect(secondId).toBeGreaterThan(firstId);
    expect(room.isInputAllowed("alice", t.terminalId, firstId)).toBe(false);
    expect(room.isInputAllowed("alice", t.terminalId, secondId)).toBe(true);
  });

  it("isInputAllowed: 존재하지 않는 터미널은 거짓이다", () => {
    const { room } = withTerminal();
    expect(room.isInputAllowed("alice", 999, 1)).toBe(false);
  });

  it("shared 전환은 기존 임대를 해제하지 않는다 (모드 전환은 임대에 관여하지 않음 — 계약 핀)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);

    room.setTerminalMode(t.terminalId, "shared");

    expect(room.leaseOf(t.terminalId)).toMatchObject({ holderClientId: "alice" });
    expect(room.snapshot().leases).toHaveLength(1);
  });

  it("shared에서 exclusive로 복귀하면 보존된 임대가 그대로 유효하다 (계약 핀)", () => {
    const { room, t } = withTerminal();
    const leaseId = grantedLeaseId(room.acquireLease("alice", t.terminalId));

    room.setTerminalMode(t.terminalId, "shared");
    room.setTerminalMode(t.terminalId, "exclusive");

    expect(room.isInputAllowed("alice", t.terminalId, leaseId)).toBe(true);
    expect(room.acquireLease("bob", t.terminalId)).toEqual({
      kind: "denied",
      holderClientId: "alice",
    });
  });

  it("markTerminalExited는 임대를 걷지 않는다 — 남은 임대는 isInputAllowed가 봉인한다 (계약 핀)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);

    room.markTerminalExited(t.terminalId, 0);

    expect(room.leaseOf(t.terminalId)).toMatchObject({ holderClientId: "alice" });
    expect(room.releaseLease("alice", t.terminalId)).toMatchObject({ kind: "released" });
    expect(room.snapshot().leases).toEqual([]);
  });

  it("markHostOffline은 임대를 보존한다 (호스트 유예 복귀 시 참여자 임대 유지)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);
    room.markHostOffline("h1");
    expect(room.leaseOf(t.terminalId)).toMatchObject({ holderClientId: "alice" });
  });

  it("removeHost는 제거된 터미널의 임대도 함께 걷는다 (stale lease 방지)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);

    room.removeHost("h1");

    expect(room.leaseOf(t.terminalId)).toBeUndefined();
    expect(room.snapshot().leases).toEqual([]);
  });
});

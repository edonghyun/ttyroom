import { describe, expect, it } from "vitest";
import { Room } from "./room.js";

const makeRoom = () => new Room({ roomId: "r1", token: "tok" });

describe("Room — 역할: Room 라이브 상태와 불변식의 소유자", () => {
  it("참여자를 추가하면 스냅샷에 나타난다", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    expect(room.snapshot().participants).toEqual([{ clientId: "c1", name: "동현" }]);
  });

  it("같은 clientId로 다시 추가하면 중복 없이 이름만 갱신된다 (재접속 멱등)", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    room.addParticipant("c1", "동현2");
    expect(room.snapshot().participants).toEqual([{ clientId: "c1", name: "동현2" }]);
  });

  it("Host 연결 후 openTerminal은 증가하는 terminalId로 exclusive 터미널을 만든다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    const t1 = room.openTerminal("h1");
    const t2 = room.openTerminal("h1");
    expect([t1.terminalId, t2.terminalId]).toEqual([1, 2]);
    expect(t1).toMatchObject({ hostId: "h1", mode: "exclusive", status: "open", exitCode: null });
  });

  it("없는 Host에 openTerminal하면 throw한다 (프로그래머 오류)", () => {
    expect(() => makeRoom().openTerminal("nope")).toThrow();
  });

  it("Host를 offline으로 표시해도 터미널은 스냅샷에 남는다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    room.openTerminal("h1");
    room.markHostOffline("h1");
    expect(room.snapshot().hosts).toEqual([{ hostId: "h1", name: "동현-Mac", online: false }]);
    expect(room.snapshot().terminals).toHaveLength(1);
  });

  it("removeHost는 host와 그 터미널을 제거하고 terminalId 목록을 돌려준다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
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
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t = room.openTerminal("h1");
    room.markTerminalExited(t.terminalId, 0);
    expect(room.terminal(t.terminalId)).toMatchObject({ status: "exited", exitCode: 0 });
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
    expect(room.snapshot().hosts).toEqual([{ hostId: "h1", name: "동현-Mac-2", online: true }]);
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
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t = room.openTerminal("h1");
    room.setTerminalMode(t.terminalId, "shared");
    expect(room.terminal(t.terminalId)).toMatchObject({ mode: "shared" });
  });

  it("없는 터미널에 setTerminalMode하면 throw한다 (프로그래머 오류)", () => {
    expect(() => makeRoom().setTerminalMode(99, "shared")).toThrow();
  });

  it("updateTerminalMeta는 터미널의 meta를 갱신해 스냅샷에 반영한다", () => {
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t = room.openTerminal("h1");
    room.updateTerminalMeta(t.terminalId, { cwd: "/repo", gitBranch: "main", fgProcess: "vim" });
    expect(room.terminal(t.terminalId)?.meta).toEqual({
      cwd: "/repo",
      gitBranch: "main",
      fgProcess: "vim",
    });
  });

  it("openTerminal이 돌려준 뷰를 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const room = makeRoom();
    room.connectHost("h1", "h");

    const created = room.openTerminal("h1");
    created.status = "exited";
    created.meta.cwd = "/oops";

    expect(room.terminal(created.terminalId)).toMatchObject({
      status: "open",
      meta: { cwd: null },
    });
  });

  it("terminal()이 돌려준 뷰를 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t = room.openTerminal("h1");

    // 직전 openTerminal이 만든 id — 존재가 보장된다
    const view = room.terminal(t.terminalId)!;
    view.mode = "shared";
    view.meta.cwd = "/oops";

    expect(room.terminal(t.terminalId)).toMatchObject({
      mode: "exclusive",
      meta: { cwd: null },
    });
  });

  it("스냅샷을 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t = room.openTerminal("h1");

    // 직전 openTerminal로 터미널 1개가 보장된다 — [0]은 항상 존재
    const snap = room.snapshot();
    snap.terminals[0]!.status = "exited";
    snap.terminals[0]!.meta.cwd = "/oops";

    expect(room.terminal(t.terminalId)).toMatchObject({
      status: "open",
      meta: { cwd: null },
    });
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

    // 직전 acquireLease가 granted한 터미널 — 임대 존재가 보장된다
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
    // 유예 중 단절 참여자는 removeParticipant 전이라 여전히 참여자다 — 유예 복원(T2.9)과 충돌하지 않는다
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
    const d = room.acquireLease("alice", t.terminalId);
    const leaseId = d.kind === "granted" ? d.lease.leaseId : -1;
    expect(room.isInputAllowed("alice", t.terminalId, leaseId)).toBe(true);
    expect(room.isInputAllowed("alice", t.terminalId, leaseId + 99)).toBe(false); // 오래된 leaseId 우회 차단
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
    const d = room.acquireLease("alice", t.terminalId);
    const leaseId = d.kind === "granted" ? d.lease.leaseId : -1;
    room.markTerminalExited(t.terminalId, 0);
    expect(room.isInputAllowed("alice", t.terminalId, leaseId)).toBe(false);
  });

  it("release 후 재획득은 새 leaseId를 발급하고 이전 leaseId는 무효다 (leaseId 비재사용)", () => {
    const { room, t } = withTerminal();
    const first = room.acquireLease("alice", t.terminalId);
    const firstId = first.kind === "granted" ? first.lease.leaseId : -1;

    room.releaseLease("alice", t.terminalId);
    const second = room.acquireLease("alice", t.terminalId);
    const secondId = second.kind === "granted" ? second.lease.leaseId : -1;

    // 오래된 leaseId 우회 차단의 전제 — leaseId가 재사용되면 lease-invalid 검증이 뚫린다
    expect(secondId).toBeGreaterThan(firstId);
    expect(room.isInputAllowed("alice", t.terminalId, firstId)).toBe(false);
    expect(room.isInputAllowed("alice", t.terminalId, secondId)).toBe(true);
  });

  it("isInputAllowed: 존재하지 않는 터미널은 거짓이다", () => {
    const { room } = withTerminal();
    expect(room.isInputAllowed("alice", 999, 1)).toBe(false);
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

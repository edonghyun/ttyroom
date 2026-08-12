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

  it("스냅샷을 변경해도 Room 내부 상태는 오염되지 않는다 (구조 복사 불변식)", () => {
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t = room.openTerminal("h1");

    const snap = room.snapshot();
    snap.terminals[0]!.status = "exited";
    snap.terminals[0]!.meta.cwd = "/oops";

    expect(room.terminal(t.terminalId)).toMatchObject({
      status: "open",
      meta: { cwd: null },
    });
  });
});

import { describe, expect, it } from "vitest";
import { Room } from "../domain/room.js";
import { toRoomSnapshot } from "./room-protocol.js";

describe("room protocol mapper — 역할: domain state를 published language로 번역", () => {
  it("Room 상태 전체를 protocol snapshot으로 명시적으로 복사한다", () => {
    const room = new Room({ roomId: "r1", token: "tok", name: "Pairing" });
    room.addParticipant("p1", "Kim");
    room.connectHost("h1", "Mac");
    const terminal = room.openTerminal("h1");
    room.updateTerminalGeometry(terminal.terminalId, {
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
    room.updateTerminalMeta(terminal.terminalId, {
      cwd: "/repo",
      gitBranch: "main",
      fgProcess: "vim",
    });
    room.acquireLease("p1", terminal.terminalId);

    const state = room.snapshot();
    const snapshot = toRoomSnapshot(state);

    expect(snapshot).toEqual(state);
    expect(snapshot).not.toBe(state);
    expect(snapshot.participants[0]).not.toBe(state.participants[0]);
    expect(snapshot.hosts[0]).not.toBe(state.hosts[0]);
    expect(snapshot.terminals[0]).not.toBe(state.terminals[0]);
    expect(snapshot.terminals[0]?.geometry).not.toBe(state.terminals[0]?.geometry);
    expect(snapshot.terminals[0]?.meta).not.toBe(state.terminals[0]?.meta);
    expect(snapshot.leases[0]).not.toBe(state.leases[0]);
  });
});

import type { ServerMessage } from "@ttyroom/protocol";
import { describe, expect, it } from "vitest";
import { expectMessageToMatch, expectNoMessage } from "./matchers.js";

describe("expectMessageToMatch — 역할: 진단 가능한 메시지 스트림 어서션", () => {
  it("일치하는 메시지가 있으면 통과한다", () => {
    const received = [{ type: "sync", terminalId: 1, seq: 5 }] as ServerMessage[];
    expect(() => expectMessageToMatch(received, "sync", { seq: 5 })).not.toThrow();
  });

  it("없으면 수신된 type 목록을 담아 실패한다", () => {
    const received = [{ type: "sync", terminalId: 1, seq: 5 }] as ServerMessage[];
    expect(() => expectMessageToMatch(received, "welcome", {})).toThrow(/received types: sync/);
  });

  it("같은 type이 있어도 partial이 불일치하면 그 메시지의 JSON을 담아 실패한다", () => {
    const received = [{ type: "sync", terminalId: 1, seq: 5 }] as ServerMessage[];
    expect(() => expectMessageToMatch(received, "sync", { seq: 99 })).toThrow(/"seq":5/);
  });

  it("중첩 객체·배열 원소도 partial로 매치한다 (계획 Task 6의 welcome 단언 형태)", () => {
    const received = [
      {
        type: "welcome",
        selfClientId: "alice-id",
        snapshot: {
          roomId: "r1",
          name: "Quick Room",
          participants: [{ clientId: "alice-id", name: "alice", focusedTerminalId: null }],
          hosts: [],
          terminals: [],
          leases: [],
        },
      },
    ] as ServerMessage[];

    expect(() =>
      expectMessageToMatch(received, "welcome", {
        selfClientId: "alice-id",
        snapshot: { roomId: "r1", participants: [{ name: "alice" }] },
      }),
    ).not.toThrow();
  });

  it("배열은 길이가 다르면 원소가 부분 일치해도 실패한다", () => {
    const received = [
      {
        type: "welcome",
        selfClientId: "a",
        snapshot: {
          roomId: "r1",
          name: "Quick Room",
          participants: [
            { clientId: "a", name: "alice", focusedTerminalId: null },
            { clientId: "b", name: "bob", focusedTerminalId: null },
          ],
          hosts: [],
          terminals: [],
          leases: [],
        },
      },
    ] as ServerMessage[];

    expect(() =>
      expectMessageToMatch(received, "welcome", {
        snapshot: { participants: [{ name: "alice" }] },
      }),
    ).toThrow(/기대 partial/);
  });
});

describe("expectNoMessage — 역할: 금지된 메시지의 부재 어서션", () => {
  it("해당 type이 없으면 통과한다", () => {
    const received = [{ type: "sync", terminalId: 1, seq: 5 }] as ServerMessage[];
    expect(() => expectNoMessage(received, "welcome")).not.toThrow();
  });

  it("해당 type이 있으면 그 메시지의 JSON을 담아 실패한다", () => {
    const received = [{ type: "sync", terminalId: 1, seq: 5 }] as ServerMessage[];
    expect(() => expectNoMessage(received, "sync")).toThrow(/"terminalId":1/);
  });
});

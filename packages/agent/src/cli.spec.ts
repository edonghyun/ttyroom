import { describe, expect, it } from "vitest";
import { parseCli } from "./cli.js";

describe("parseCli — 역할: join 명령의 해석", () => {
  it("joinUrl에서 roomId·token·wsUrl을 뽑아낸다", () => {
    const cmd = parseCli(["join", "http://localhost:8080/r/lively-fox#tok123"], {
      hostname: "mac",
    });

    expect(cmd).toEqual({
      kind: "join",
      httpUrl: "http://localhost:8080",
      roomId: "lively-fox",
      token: "tok123",
      wsUrl: "ws://localhost:8080/ws",
      name: "mac",
    });
  });

  it("--name이 hostname을 덮는다", () => {
    const cmd = parseCli(
      ["join", "http://localhost:8080/r/lively-fox#tok123", "--name", "데브서버"],
      {
        hostname: "mac",
      },
    );

    expect(cmd).toMatchObject({ kind: "join", name: "데브서버" });
  });

  it("토큰 없는 URL은 invalid다", () => {
    const cmd = parseCli(["join", "http://localhost:8080/r/lively-fox"], { hostname: "mac" });

    expect(cmd).toMatchObject({ kind: "invalid" });
  });

  it("모르는 서브커맨드는 invalid다", () => {
    const cmd = parseCli(["serve"], { hostname: "mac" });

    expect(cmd).toMatchObject({ kind: "invalid" });
  });

  it("https joinUrl은 wss로 매핑된다", () => {
    const cmd = parseCli(["join", "https://ttyroom.example.com/r/foo#tok"], { hostname: "mac" });

    expect(cmd).toMatchObject({ kind: "join", wsUrl: "wss://ttyroom.example.com/ws" });
  });

  it("http(s)가 아닌 joinUrl은 연결 명령으로 만들지 않는다", () => {
    const cmd = parseCli(["join", "ftp://ttyroom.example.com/r/foo#tok"], {
      hostname: "mac",
    });

    expect(cmd).toMatchObject({ kind: "invalid" });
  });

  it("잘못된 joinUrl 오류에 초대 토큰 원문을 노출하지 않는다", () => {
    const secretToken = "super-secret-token";
    const cmd = parseCli(["join", `not a url#${secretToken}`], { hostname: "mac" });

    expect(cmd).toMatchObject({ kind: "invalid" });
    if (cmd.kind === "invalid") expect(cmd.reason).not.toContain(secretToken);
  });

  it("URL이 아니거나 /r/<roomId> 형식이 아니면 invalid다", () => {
    expect(parseCli(["join", "not-a-url"], { hostname: "mac" })).toMatchObject({
      kind: "invalid",
    });
    expect(
      parseCli(["join", "http://localhost:8080/rooms/foo#tok"], { hostname: "mac" }),
    ).toMatchObject({ kind: "invalid" });
  });
});

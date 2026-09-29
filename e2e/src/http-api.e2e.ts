import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerProcess } from "./server-process.js";

// Share only the process. Each request creates its own room; no test consumes another's state.
describe("방 생성 HTTP 계약 — Node/Spring 공통", () => {
  let server: ServerProcess;
  beforeAll(async () => {
    server = await ServerProcess.start({}, { startupTimeoutMs: 30_000 });
  }, 30_000);
  afterAll(async () => {
    await server?.close();
  });

  function createRoom(body: string) {
    // Deliberately no JSON content-type: the existing endpoint parses the body regardless.
    return fetch(`${server.baseUrl}/api/rooms`, { method: "POST", body });
  }

  it.each([
    ["", "Quick Room"],
    ["{}", "Quick Room"],
    ['{"name":"  API logs  ","ignored":true}', "API logs"],
    [JSON.stringify({ name: "\uFEFF\u00A0방\u3000" }), "방"],
    [JSON.stringify({ name: "a".repeat(80) }), "a".repeat(80)],
    [JSON.stringify({ name: "😀".repeat(40) }), "😀".repeat(40)],
  ])("요청 %j는 이름 %s인 초대 링크를 만든다", async (body, name) => {
    const response = await createRoom(body);
    const room = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    // Shared fields; Spring's additive manager credential is checked in registration.spring.ts.
    expect(room).toMatchObject({
      roomId: expect.any(String),
      name,
      token: expect.any(String),
      joinUrl: expect.any(String),
    });
    expect(room.roomId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(room.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(room.joinUrl).toBe(`${server.baseUrl}/r/${room.roomId}#${room.token}`);
  });

  it.each([
    ["{", "invalid json"],
    [" ", "invalid json"],
    ["{} {}", "invalid json"],
    ["null", "invalid room name"],
    ["[]", "invalid room name"],
    ['{"name":null}', "invalid room name"],
    ['{"name":42}', "invalid room name"],
    ['{"name":"  "}', "invalid room name"],
    [JSON.stringify({ name: "a".repeat(81) }), "invalid room name"],
    [JSON.stringify({ name: "😀".repeat(41) }), "invalid room name"],
    [JSON.stringify({ ignored: "가".repeat(6000) }), "request body too large"],
  ])("잘못된 요청 사례 %#는 계약대로 거절한다", async (body, error) => {
    const response = await createRoom(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  it.each([16_384, 16_385])("본문 경계 %i bytes를 적용한다", async (size) => {
    const body = JSON.stringify({ ignored: "x".repeat(size - '{"ignored":""}'.length) });

    const response = await createRoom(body);

    expect(response.status).toBe(size === 16_384 ? 201 : 400);
    if (size > 16_384) expect(await response.json()).toEqual({ error: "request body too large" });
  });

  it("요청마다 서로 다른 방과 초대 토큰을 발급한다", async () => {
    const first = await (await createRoom("{}")).json();
    const second = await (await createRoom("{}")).json();

    expect(first.roomId).not.toBe(second.roomId);
    expect(first.token).not.toBe(second.token);
  });

  it.each(["/api", "/api/missing", "/api/rooms"])(
    "미지원 GET %s는 API 오류 형식을 유지한다",
    async (path) => {
      const response = await fetch(`${server.baseUrl}${path}`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    },
  );
});

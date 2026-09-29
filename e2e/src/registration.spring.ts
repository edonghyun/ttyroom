import { describe, expect, it } from "vitest";
import { ServerProcess } from "./server-process.js";

interface ManagedRoom {
  roomId: string;
  token: string;
  managerCredential: string;
}

async function post(server: ServerProcess, path: string, body: unknown, bearer?: string) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: (await response.json()) as Record<string, string>,
  };
}

async function springServer() {
  if (!process.env.TTYROOM_E2E_SERVER_COMMAND)
    throw new Error("Run with ./scripts/test-spring.sh registration to select the Spring JAR");
  return ServerProcess.start({}, { startupTimeoutMs: 30_000 });
}

async function givenManagedRoom(server: ServerProcess): Promise<ManagedRoom> {
  const response = await post(server, "/api/rooms", {});
  const { roomId, token, managerCredential } = response.body;
  if (response.status !== 201 || !roomId || !token || !managerCredential)
    throw new Error("Managed-room fixture could not create a room");
  return { roomId, token, managerCredential };
}

function expectIssued(response: Awaited<ReturnType<typeof post>>, idField: string) {
  expect(response.status).toBe(201);
  expect(response.cacheControl).toBe("no-store");
  expect(response.body).toEqual({
    [idField]: expect.stringMatching(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    ),
    credential: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
  });
}

function expectForbidden(response: Awaited<ReturnType<typeof post>>) {
  expect(response).toEqual({
    status: 403,
    cacheControl: "no-store",
    body: { error: "registration forbidden" },
  });
}

describe("Spring 등록 HTTP 계약", () => {
  it("방 생성은 관리 비밀을 초대 링크와 분리하고 캐시를 금지한다", async () => {
    await using server = await springServer();

    const response = await post(server, "/api/rooms", {});

    expect(response.status).toBe(201);
    expect(response.cacheControl).toBe("no-store");
    expect(response.body).toEqual({
      roomId: expect.any(String),
      name: "Quick Room",
      token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      managerCredential: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      joinUrl: expect.any(String),
    });
    expect(response.body.managerCredential).not.toBe(response.body.token);
    expect(response.body.joinUrl).toBe(
      `${server.baseUrl}/r/${response.body.roomId}#${response.body.token}`,
    );
  });

  it("초대 토큰은 참가자만 등록하며 반복 등록은 독립된 주체를 만든다", async () => {
    await using server = await springServer();
    const room = await givenManagedRoom(server);
    const path = `/api/rooms/${room.roomId}`;

    const first = await post(server, `${path}/participants`, { token: room.token });
    const second = await post(server, `${path}/participants`, { token: room.token });
    const denied = await post(server, `${path}/hosts`, {}, room.token);

    expectIssued(first, "participantId");
    expectIssued(second, "participantId");
    expect(second.body.participantId).not.toBe(first.body.participantId);
    expect(second.body.credential).not.toBe(first.body.credential);
    expectForbidden(denied);
  });

  it("서버 재시작 후에도 관리 credential로 host를 등록하고 다른 방에서는 거절한다", async () => {
    await using server = await springServer();
    const room = await givenManagedRoom(server);
    const other = await givenManagedRoom(server);
    const previousPid = server.pid;

    await server.restart();
    const host = await post(server, `/api/rooms/${room.roomId}/hosts`, {}, room.managerCredential);
    const denied = await post(
      server,
      `/api/rooms/${other.roomId}/hosts`,
      {},
      room.managerCredential,
    );

    expect(server.pid).not.toBe(previousPid);
    expectIssued(host, "hostId");
    expectForbidden(denied);
  });

  it("요청자가 기존 ID나 역할을 고르면 실제 HTTP 경계에서 거절한다", async () => {
    await using server = await springServer();
    const room = await givenManagedRoom(server);

    const response = await post(server, `/api/rooms/${room.roomId}/participants`, {
      token: room.token,
      participantId: "chosen",
      role: "host",
    });

    expect(response).toEqual({
      status: 400,
      cacheControl: "no-store",
      body: { error: "invalid registration request" },
    });
  });
});

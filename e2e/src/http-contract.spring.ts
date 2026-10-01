import { beforeAll, describe, expect, it } from "vitest";
import { HttpContract, type HttpObservation } from "./http-contract.js";
import { readFileSync } from "node:fs";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";
import { ServerProcess } from "@ttyroom/test-support/server-process";

let contract: HttpContract;
beforeAll(async () => {
  contract = await HttpContract.load();
});

async function request(
  server: ServerProcess,
  path: string,
  method: string,
  body?: unknown,
  bearer?: string,
): Promise<HttpObservation> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function springServer() {
  if (!process.env.TTYROOM_E2E_SERVER_COMMAND)
    throw new Error("Run ./scripts/test-spring.sh registration");
  return ServerProcess.start({}, { protocolVersion: 8, startupTimeoutMs: 30_000 });
}

async function givenManagedRoom(server: ServerProcess) {
  const response = await request(
    server,
    "/api/rooms",
    "POST",
    contract.requestExample("createRoom"),
  );
  if (response.status !== 201) throw new Error("Managed room fixture failed");
  return JSON.parse(response.body) as { roomId: string; token: string; managerCredential: string };
}

function expectDocumented(id: string, response: HttpObservation, status: number) {
  expect(response.status).toBe(status);
  expect(contract.responseViolations(id, response)).toEqual([]);
}

describe("real Spring responses satisfy the HTTP specification", () => {
  it("health and room creation match their documented envelopes", async () => {
    await using server = await springServer();

    const health = await request(server, "/healthz", "GET");
    const created = await request(
      server,
      "/api/rooms",
      "POST",
      contract.requestExample("createRoom"),
    );

    expectDocumented("health", health, 200);
    expectDocumented("createRoom", created, 201);
  });

  it.each([
    {
      kind: "participants",
      register: "registerParticipant",
      revoke: "revokeParticipant",
      idField: "participantId",
    },
    { kind: "hosts", register: "registerHost", revoke: "revokeHost", idField: "hostId" },
  ])(
    "$kind registration and repeated revocation match the public contract",
    async ({ kind, register, revoke, idField }) => {
      await using server = await springServer();
      const room = await givenManagedRoom(server);
      const body = contract.requestExample(register);
      if (kind === "participants") body.token = room.token;
      const path = `/api/rooms/${room.roomId}/${kind}`;

      const registered = await request(server, path, "POST", body, room.managerCredential);
      const id = (JSON.parse(registered.body) as Record<string, string>)[idField];
      const removed = await request(
        server,
        `${path}/${id}`,
        "DELETE",
        contract.requestExample(revoke),
        room.managerCredential,
      );
      const repeated = await request(
        server,
        `${path}/${id}`,
        "DELETE",
        undefined,
        room.managerCredential,
      );

      expectDocumented(register, registered, 201);
      expectDocumented(revoke, removed, 204);
      expectDocumented(revoke, repeated, 204);
    },
  );

  it.each([
    { kind: "participants", operation: "registerParticipant" },
    { kind: "hosts", operation: "registerHost" },
  ])(
    "$kind registration rejection matches documented 400 and 403 responses",
    async ({ kind, operation }) => {
      await using server = await springServer();
      const room = await givenManagedRoom(server);
      const path = `/api/rooms/${room.roomId}/${kind}`;

      const malformed = await request(
        server,
        path,
        "POST",
        { role: "host" },
        room.managerCredential,
      );
      const unauthorized = await request(
        server,
        path,
        "POST",
        contract.requestExample(operation),
        "x".repeat(32),
      );

      expectDocumented(operation, malformed, 400);
      expectDocumented(operation, unauthorized, 403);
    },
  );

  it.each([
    { kind: "participants", operation: "revokeParticipant" },
    { kind: "hosts", operation: "revokeHost" },
  ])(
    "$kind revocation rejection matches documented 400 and 403 responses",
    async ({ kind, operation }) => {
      await using server = await springServer();
      const room = await givenManagedRoom(server);
      const path = `/api/rooms/${room.roomId}/${kind}`;

      const malformed = await request(
        server,
        `${path}/invalid-id`,
        "DELETE",
        {},
        room.managerCredential,
      );
      const unauthorized = await request(server, `${path}/${room.roomId}`, "DELETE", {});

      expectDocumented(operation, malformed, 400);
      expectDocumented(operation, unauthorized, 403);
    },
  );

  it("invalid room creation matches the documented JSON error", async () => {
    await using server = await springServer();

    const response = await request(server, "/api/rooms", "POST", { name: 42 });

    expectDocumented("createRoom", response, 400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

it("the documented v8 hello and revocation error work against the real server", async () => {
  await using server = await springServer();
  const room = await givenManagedRoom(server);
  const issued = await request(server, `/api/rooms/${room.roomId}/participants`, "POST", {
    token: room.token,
  });
  if (issued.status !== 201) throw new Error("Participant fixture failed");
  const participant = JSON.parse(issued.body) as { participantId: string; credential: string };
  const wire = JSON.parse(
    readFileSync(new URL("../../protocol/fixtures/wire-v8.json", import.meta.url), "utf8"),
  );
  await using peer = await SocketProbe.connect(server.baseUrl);

  peer.send({
    ...wire["credential-hello"],
    roomId: room.roomId,
    credential: participant.credential,
  });
  const welcome = await peer.next();
  const revoked = await request(
    server,
    `/api/rooms/${room.roomId}/participants/${participant.participantId}`,
    "DELETE",
    {},
    room.managerCredential,
  );
  const rejection = await peer.next();
  await peer.closed();

  expect(welcome).toMatchObject({ type: "welcome", selfClientId: participant.participantId });
  expectDocumented("revokeParticipant", revoked, 204);
  expect(rejection).toEqual(wire["invalid-credential"]);
});

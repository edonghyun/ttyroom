import { describe, expect, it } from "vitest";
import { ServerProcess } from "./server-process.js";
import { SocketProbe } from "./socket-probe.js";

interface Credential {
  id: string;
  secret: string;
}

async function registeredRoom(protocolVersion: 7 | 8 = 8) {
  if (!process.env.TTYROOM_E2E_SERVER_COMMAND)
    throw new Error("Run with ./scripts/test-spring.sh authentication to select the Spring JAR");
  const server = await ServerProcess.start({}, { protocolVersion, startupTimeoutMs: 30_000 });
  const peers: SocketProbe[] = [];
  async function post(path: string, body: unknown, bearer?: string) {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 201)
      throw new Error(`Registration fixture failed: HTTP ${response.status}`);
    return (await response.json()) as Record<string, string>;
  }
  try {
    const { roomId, token, managerCredential } = await post("/api/rooms", {});
    if (!roomId || !token || !managerCredential)
      throw new Error("Managed room fixture has missing fields");
    const invitation = { roomId, token, managerCredential };
    const path = `/api/rooms/${invitation.roomId}`;
    return {
      server,
      invitation,
      async participant(): Promise<Credential> {
        const issued = await post(`${path}/participants`, { token: invitation.token });
        const { participantId, credential } = issued;
        if (!participantId || !credential)
          throw new Error("Participant registration fixture has missing fields");
        return { id: participantId, secret: credential };
      },
      async host(): Promise<Credential> {
        const issued = await post(`${path}/hosts`, {}, invitation.managerCredential);
        const { hostId, credential } = issued;
        if (!hostId || !credential) throw new Error("Host registration fixture has missing fields");
        return { id: hostId, secret: credential };
      },
      async participantInAnotherRoom(): Promise<Credential> {
        const other = await post("/api/rooms", {});
        const issued = await post(`/api/rooms/${other.roomId}/participants`, {
          token: other.token,
        });
        const { participantId, credential } = issued;
        if (!participantId || !credential)
          throw new Error("Foreign participant fixture has missing fields");
        return { id: participantId, secret: credential };
      },
      async connect(secret: string, name: string, extra: Record<string, unknown> = {}) {
        const peer = await SocketProbe.connect(server.baseUrl);
        peers.push(peer);
        peer.send({
          type: "hello",
          protocolVersion: 8,
          roomId: invitation.roomId,
          credential: secret,
          name,
          ...extra,
        });
        return { peer, message: await peer.next() };
      },
      async legacyHello() {
        const peer = await SocketProbe.connect(server.baseUrl);
        peers.push(peer);
        peer.send({
          type: "hello",
          protocolVersion: 7,
          roomId: invitation.roomId,
          token: invitation.token,
          clientId: "chosen",
          name: "Legacy",
          role: "host",
        });
        return { peer, message: await peer.next() };
      },
      async [Symbol.asyncDispose]() {
        try {
          await Promise.all(peers.map((peer) => peer[Symbol.asyncDispose]()));
        } finally {
          await server.close();
        }
      },
    };
  } catch (failure) {
    await server.close();
    throw failure;
  }
}

describe("Spring v8 입장 인증", () => {
  it("participant credential의 주체 ID로 입장한다", async () => {
    await using room = await registeredRoom();
    const alice = await room.participant();

    const connected = await room.connect(alice.secret, "Alice");

    expect(connected.message).toMatchObject({
      type: "welcome",
      selfClientId: alice.id,
      snapshot: { participants: [{ clientId: alice.id, name: "Alice" }], hosts: [] },
    });
    expect(JSON.stringify(connected.message)).not.toContain(alice.secret);
    expect(JSON.stringify(connected.message)).not.toContain(room.invitation.managerCredential);
  });

  it.each(["invitation", "manager", "unknown"] as const)(
    "%s은 연결 credential로 사용할 수 없다",
    async (kind) => {
      await using room = await registeredRoom();
      const secret = {
        invitation: room.invitation.token,
        manager: room.invitation.managerCredential,
        unknown: "A".repeat(32),
      }[kind];

      const rejected = await room.connect(secret, "Rejected");
      await rejected.peer.closed();

      expect(rejected.message).toEqual({
        type: "error",
        code: "invalid-credential",
        message: "invalid-credential",
      });
    },
  );

  it("같은 서버의 다른 방에서 발급한 credential도 거절한다", async () => {
    await using room = await registeredRoom();
    const other = await room.participantInAnotherRoom();

    const rejected = await room.connect(other.secret, "Other room");
    await rejected.peer.closed();

    expect(rejected.message).toEqual({
      type: "error",
      code: "invalid-credential",
      message: "invalid-credential",
    });
  });

  it("v8 프로세스는 유효한 초대 토큰을 가진 v7 hello도 거절한다", async () => {
    await using room = await registeredRoom();

    const rejected = await room.legacyHello();
    await rejected.peer.closed();

    expect(rejected.message).toEqual({
      type: "error",
      code: "unsupported-protocol-version",
      message: "server=8",
    });
  });

  it("v7 프로세스도 v8 hello를 협상하거나 자동으로 수락하지 않는다", async () => {
    await using room = await registeredRoom(7);
    const alice = await room.participant();

    const rejected = await room.connect(alice.secret, "Alice");
    await rejected.peer.closed();

    expect(rejected.message).toEqual({
      type: "error",
      code: "unsupported-protocol-version",
      message: "server=7",
    });
  });

  it.each(["role", "clientId", "hostId", "token"])(
    "%s을 지정해 기존 연결이나 역할을 선택할 수 없다",
    async (field) => {
      await using room = await registeredRoom();
      const alice = await room.participant();
      const bob = await room.participant();
      const current = await room.connect(alice.secret, "Alice");
      if (current.message.type !== "welcome") throw new Error("Alice fixture was not admitted");

      const rejected = await room.connect(bob.secret, "Attacker", { [field]: alice.id });
      current.peer.send({ type: "acquire-lease", terminalId: 42 });
      const stillConnected = await current.peer.next();

      expect(rejected.message).toMatchObject({ type: "error", code: "bad-message" });
      expect(stillConnected).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    },
  );

  it("동일 credential 재접속은 같은 주체만 교체한다", async () => {
    await using room = await registeredRoom();
    const alice = await room.participant();
    const original = await room.connect(alice.secret, "Original");
    if (original.message.type !== "welcome") throw new Error("Original fixture was not admitted");

    const replacement = await room.connect(alice.secret, "Replacement");
    await original.peer.closed();
    replacement.peer.send({ type: "acquire-lease", terminalId: 42 });
    const stillConnected = await replacement.peer.next();

    expect(replacement.message).toMatchObject({
      type: "welcome",
      selfClientId: alice.id,
      snapshot: { participants: [{ clientId: alice.id, name: "Replacement" }] },
    });
    expect(stillConnected).toMatchObject({ type: "lease-invalid", terminalId: 42 });
  });

  it("재시작 후에도 host credential을 복원하고 inventory로 복구를 완료한다", async () => {
    await using room = await registeredRoom();
    const host = await room.host();
    const oldPid = room.server.pid;

    await room.server.restart();
    const connected = await room.connect(host.secret, "Computer");
    connected.peer.send({ type: "host-inventory", terminals: [] });
    const ready = await connected.peer.next();

    expect(room.server.pid).not.toBe(oldPid);
    expect(connected.message).toMatchObject({
      type: "welcome",
      selfClientId: host.id,
      snapshot: {
        participants: [],
        hosts: [{ hostId: host.id, online: false, remoteInputAllowed: false }],
      },
    });
    expect(ready).toEqual({ type: "host-ready", terminals: [] });
  });
});

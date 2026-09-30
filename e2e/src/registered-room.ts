import { ServerProcess } from "./server-process.js";
import { SocketProbe } from "./socket-probe.js";

interface Credential {
  id: string;
  secret: string;
}

export async function registeredRoom(
  protocolVersion: 7 | 8 = 8,
  command?: readonly [string, ...string[]],
) {
  if (!command && !process.env.TTYROOM_E2E_SERVER_COMMAND)
    throw new Error("Run with ./scripts/test-spring.sh authentication to select the Spring JAR");
  const server = await ServerProcess.start(
    {},
    { protocolVersion, startupTimeoutMs: 30_000, command },
  );
  const peers: SocketProbe[] = [];
  async function post(path: string, body: unknown, bearer?: string) {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
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
      async revoke(kind: "participants" | "hosts", id: string) {
        return fetch(`${server.baseUrl}${path}/${kind}/${id}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(5_000),
          headers: { Authorization: `Bearer ${invitation.managerCredential}` },
        });
      },
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

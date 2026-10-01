import { describe, expect, it } from "vitest";
import { registeredRoom } from "@ttyroom/test-support/registered-room";

describe("Spring credential 보관 한도", () => {
  it.each([
    { capacity: { credentialsPerRoom: 2 }, error: "room credentials capacity exhausted" },
    { capacity: { credentials: 2 }, error: "credentials capacity exhausted" },
  ])("manager를 포함한 한도 초과는 기존 참가자를 유지한다: $error", async ({ capacity, error }) => {
    await using room = await registeredRoom(8, { capacity });
    const alice = await room.participant();
    const connected = await room.connect(alice.secret, "Alice");

    const rejected = await registerParticipant(room);
    const body = await rejected.json();
    connected.peer.send({ type: "acquire-lease", terminalId: 42 });
    const responsive = await connected.peer.next();
    const forbidden = await registerParticipant(room, "wrong-invitation");
    const forbiddenBody = await forbidden.json();

    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ error });
    expect(responsive).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    expect(forbidden.status).toBe(403);
    expect(forbiddenBody).toEqual({ error: "registration forbidden" });
  });

  it("재시작 후에도 한도를 유지하며 취소한 슬롯만 다시 발급한다", async () => {
    await using room = await registeredRoom(8, {
      capacity: { credentialsPerRoom: 2, credentials: 2 },
    });
    const original = await room.participant();

    await room.server.restart();
    const full = await registerParticipant(room);
    const revoked = await room.revoke("participants", original.id);
    const replacement = await room.participant();
    const stillFull = await registerParticipant(room);
    const rejected = await room.connect(original.secret, "Revoked");
    const accepted = await room.connect(replacement.secret, "Replacement");

    expect(full.status).toBe(503);
    expect(revoked.status).toBe(204);
    expect(stillFull.status).toBe(503);
    expect(rejected.message).toMatchObject({ type: "error", code: "invalid-credential" });
    expect(accepted.message).toMatchObject({ type: "welcome", selfClientId: replacement.id });
  });

  it("host와 participant 발급은 같은 저장 예산을 사용한다", async () => {
    await using room = await registeredRoom(8, { capacity: { credentialsPerRoom: 2 } });
    const host = await room.host();

    const rejected = await registerParticipant(room);
    const revoked = await room.revoke("hosts", host.id);
    const participant = await room.participant();
    const joined = await room.connect(participant.secret, "Participant");

    expect(rejected.status).toBe(503);
    expect(revoked.status).toBe(204);
    expect(joined.message).toMatchObject({ type: "welcome", selfClientId: participant.id });
  });
});

function registerParticipant(
  room: Awaited<ReturnType<typeof registeredRoom>>,
  token = room.invitation.token,
) {
  return fetch(`${room.server.baseUrl}/api/rooms/${room.invitation.roomId}/participants`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

import { describe, expect, it } from "vitest";
import { registeredRoom } from "@ttyroom/test-support/registered-room";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";

describe("Spring v8 입장 인증", () => {
  it.each([65_536, 262_144])(
    "%i byte hello를 여러 조각으로 받아 한 번만 입장시킨다",
    async (bytes) => {
      await using room = await registeredRoom();
      const alice = await room.participant();
      await using peer = await SocketProbe.connect(room.server.baseUrl);
      const hello = JSON.stringify({
        type: "hello",
        protocolVersion: 8,
        roomId: room.invitation.roomId,
        credential: alice.secret,
        name: "Alice",
      });

      peer.sendTextParts(
        hello.slice(0, 1) + " ".repeat(bytes - Buffer.byteLength(hello)),
        hello.slice(1),
      );
      const welcome = await peer.next();
      peer.send({ type: "acquire-lease", terminalId: 42 });
      const nextReply = await peer.next();

      expect(welcome).toMatchObject({ type: "welcome", selfClientId: alice.id });
      expect(nextReply).toMatchObject({ type: "lease-invalid", terminalId: 42 });
    },
  );

  it("분할된 binary는 완성된 프레임 하나로 검증하고 후속 control을 받는다", async () => {
    await using room = await registeredRoom();
    const alice = await room.participant();
    const { peer } = await room.connect(alice.secret, "Alice");

    peer.sendByteParts(new Uint8Array(32_768), new Uint8Array(32_768));
    const rejected = await peer.next();
    peer.send({ type: "acquire-lease", terminalId: 42 });
    const nextReply = await peer.next();

    expect(rejected).toMatchObject({ type: "error", code: "bad-message" });
    expect(nextReply).toMatchObject({ type: "lease-invalid", terminalId: 42 });
  });

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

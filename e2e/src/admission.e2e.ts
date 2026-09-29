import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { roomFixture } from "./fixtures.js";
import { SocketProbe } from "./socket-probe.js";
import type { TestRoom } from "./harness.js";

function hello(room: TestRoom, clientId = "alice", role = "participant") {
  return {
    type: "hello",
    protocolVersion: 7,
    roomId: room.roomId,
    token: room.token,
    clientId,
    name: clientId,
    role,
  };
}

describe("WebSocket 입장 계약 — Node/Spring 공통", () => {
  it.each(["participant", "host"])(
    "%s는 토큰 인증 뒤 자기 식별자와 방 snapshot을 받는다",
    async (role) => {
      await using fixture = await roomFixture({ name: "Admissions" });
      await using peer = await SocketProbe.connect(fixture.room.baseUrl);

      peer.send(hello(fixture.room, "alice", role));
      const response = await peer.next();

      expect(response).toMatchObject({
        type: "welcome",
        selfClientId: "alice",
        snapshot: {
          roomId: fixture.room.roomId,
          name: "Admissions",
          terminals: [],
          leases: [],
          participants:
            role === "participant"
              ? [{ clientId: "alice", name: "alice", focusedTerminalId: null }]
              : [],
          hosts:
            role === "host"
              ? [{ hostId: "alice", name: "alice", online: false, remoteInputAllowed: false }]
              : [],
        },
      });
    },
  );

  it.each([
    [{ token: "invalid" }, "invalid-token"],
    [{ roomId: "missing" }, "room-not-found"],
    [{ protocolVersion: 8, token: "invalid" }, "unsupported-protocol-version"],
    [{ protocolVersion: 1e20 }, "unsupported-protocol-version"],
    [{ protocolVersion: 9223372036854776000 }, "unsupported-protocol-version"],
  ])("인증 오류 사례 %#는 오류를 보내고 연결을 종료한다", async (override, code) => {
    await using fixture = await roomFixture();
    await using peer = await SocketProbe.connect(fixture.room.baseUrl);

    peer.send({ ...hello(fixture.room), ...override });
    const response = await peer.next();
    await peer.closed();

    expect(response).toMatchObject({ type: "error", code });
  });

  it.each(["{", { type: "hello" }, { type: "acquire-lease", terminalId: 1 }])(
    "입장 전 잘못된 메시지 %#는 거절하고 정상 hello는 계속 받는다",
    async (invalid) => {
      await using fixture = await roomFixture();
      await using peer = await SocketProbe.connect(fixture.room.baseUrl);

      peer.send(invalid);
      const rejected = await peer.next();
      peer.send(hello(fixture.room));
      const welcomed = await peer.next();

      expect(rejected).toMatchObject({ type: "error", code: "bad-message" });
      expect(welcomed).toMatchObject({ type: "welcome", selfClientId: "alice" });
    },
  );

  it("다른 방의 유효한 토큰도 입장에 사용할 수 없다", async () => {
    await using fixture = await roomFixture();
    const otherRoom = await fixture.server.room();
    await using peer = await SocketProbe.connect(fixture.room.baseUrl);

    peer.send({ ...hello(fixture.room), token: otherRoom.token });
    const response = await peer.next();
    await peer.closed();

    expect(response).toMatchObject({ type: "error", code: "invalid-token" });
  });

  it("다른 참여자 입장은 기존 참여자에게만 이벤트로 전달되고 본인은 welcome으로 확인한다", async () => {
    await using fixture = await roomFixture();
    await using alice = await SocketProbe.connect(fixture.room.baseUrl);
    await using bob = await SocketProbe.connect(fixture.room.baseUrl);
    alice.send(hello(fixture.room));
    await alice.next();

    bob.send(hello(fixture.room, "bob"));
    const bobWelcome = await bob.next();
    const aliceEvent = await alice.next();

    expect(bobWelcome).toMatchObject({
      type: "welcome",
      snapshot: { participants: [{ clientId: "alice" }, { clientId: "bob" }] },
    });
    expect(aliceEvent).toMatchObject({
      type: "room-event",
      event: { kind: "participant-joined", participant: { clientId: "bob" } },
    });
  });

  it("중복 hello는 거절하고 기존 연결은 입장 알림을 계속 받는다", async () => {
    await using fixture = await roomFixture();
    await using alice = await SocketProbe.connect(fixture.room.baseUrl);
    await using bob = await SocketProbe.connect(fixture.room.baseUrl);
    alice.send(hello(fixture.room));
    await alice.next();

    alice.send(hello(fixture.room));
    const rejected = await alice.next();
    bob.send(hello(fixture.room, "bob"));
    const event = await alice.next();

    expect(rejected).toMatchObject({ type: "error", code: "bad-message" });
    expect(event).toMatchObject({ type: "room-event", event: { kind: "participant-joined" } });
  });

  it("같은 clientId의 새 연결이 기존 연결을 대체하고 이전 close가 새 연결을 제거하지 않는다", async () => {
    await using fixture = await roomFixture();
    await using old = await SocketProbe.connect(fixture.room.baseUrl);
    await using current = await SocketProbe.connect(fixture.room.baseUrl);
    old.send(hello(fixture.room));
    await old.next();

    current.send(hello(fixture.room));
    const welcome = await current.next();
    await old.closed();
    await using bob = await SocketProbe.connect(fixture.room.baseUrl);
    bob.send(hello(fixture.room, "bob"));
    const event = await current.next();

    expect(welcome).toMatchObject({
      type: "welcome",
      snapshot: { participants: [{ clientId: "alice" }] },
    });
    expect(event).toMatchObject({
      type: "room-event",
      event: { participant: { clientId: "bob" } },
    });
  });
  it("8KiB를 넘는 유효한 hello도 Node와 같이 입장할 수 있다", async () => {
    await using fixture = await roomFixture();
    await using peer = await SocketProbe.connect(fixture.room.baseUrl);
    const name = "x".repeat(9_000);

    peer.send({ ...hello(fixture.room), name });
    const response = await peer.next();

    expect(response).toMatchObject({ type: "welcome", snapshot: { participants: [{ name }] } });
  });

  it("host가 종료되면 유예 만료 전에 관찰자에게 offline을 알린다", async () => {
    await using fixture = await roomFixture();
    await using observer = await SocketProbe.connect(fixture.room.baseUrl);
    await using host = await SocketProbe.connect(fixture.room.baseUrl);
    observer.send(hello(fixture.room));
    await observer.next();
    host.send(hello(fixture.room, "host", "host"));
    await host.next();

    await host.disconnect();
    const event = await observer.next();

    expect(event).toMatchObject({
      type: "room-event",
      event: { kind: "host-offline", hostId: "host" },
    });
  });

  it("마지막 참여자의 유예가 끝나면 방과 초대 링크가 만료된다", async () => {
    await using fixture = await roomFixture();
    await using participant = await SocketProbe.connect(fixture.room.baseUrl);
    participant.send(hello(fixture.room));
    await participant.next();

    await participant.disconnect();
    // Exercise the public 15s grace period; joining to poll would reset that very deadline.
    await delay(16_000);
    await using late = await SocketProbe.connect(fixture.room.baseUrl);
    late.send(hello(fixture.room));
    const response = await late.next();

    expect(response).toMatchObject({ type: "error", code: "room-not-found" });
  });
});

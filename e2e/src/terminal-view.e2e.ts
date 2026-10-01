import { describe, expect, it } from "vitest";
import { protocolWorkspaceFixture } from "./protocol-fixture.js";
import { SocketProbe } from "@ttyroom/test-support/socket-probe";

const geometry = { x: -65535, y: 65535, width: 0.5, height: 65535 };
const rename = (title: unknown, terminalId = 7) => ({ type: "rename-terminal", terminalId, title });
const move = (value: unknown = geometry, terminalId = 7) => ({
  type: "update-terminal-geometry",
  terminalId,
  geometry: value,
});

async function request(peer: SocketProbe, command: unknown) {
  peer.send(command);
  return peer.next();
}

/** An ordered reply makes unexpected extra events visible without timing-based absence checks. */
async function boundary(peer: SocketProbe) {
  return request(peer, { type: "acquire-lease", terminalId: 0xfffffffe });
}

async function viewFixture(state: "open" | "exited" | "offline" | "pending" = "open") {
  const fixture = await protocolWorkspaceFixture(state === "pending" ? [] : [7]);
  try {
    let terminalId = 7;
    if (state === "pending") {
      fixture.observer.send({ type: "open-terminal-request", hostId: "host" });
      const reservation = await fixture.host.next();
      if (reservation.type !== "open-terminal") throw new Error("Expected terminal reservation");
      terminalId = reservation.terminalId;
    }
    const lease = await request(fixture.observer, { type: "acquire-lease", terminalId });
    if (lease.type !== "lease-result" || lease.result.kind !== "granted")
      throw new Error("View fixture requires Alice's lease before Bob edits");
    const granted = await fixture.observer.next();
    if (granted.type !== "room-event" || granted.event.kind !== "lease-granted")
      throw new Error("Expected lease publication");
    if (state === "exited") {
      fixture.host.send({ type: "terminal-closed", terminalId, exitCode: 9 });
      const closed = await fixture.observer.next();
      if (closed.type !== "room-event" || closed.event.kind !== "terminal-closed")
        throw new Error("Expected terminal exit before view edits");
    } else if (state === "offline") {
      await fixture.host.disconnect();
      const offline = await fixture.observer.next();
      if (offline.type !== "room-event" || offline.event.kind !== "host-offline")
        throw new Error("Expected host disconnect before view edits");
    }
    const { peer: bob, welcome } = await fixture.join("bob", "participant");
    if (state !== "exited") {
      const sync = await bob.next();
      if (sync.type !== "sync" || sync.terminalId !== terminalId || sync.seq !== 0)
        throw new Error("Expected empty-history sync before view edits");
    }
    const joined = await fixture.observer.next();
    if (joined.type !== "room-event" || joined.event.kind !== "participant-joined")
      throw new Error("Expected Bob's arrival before view edits");
    return { ...fixture, bob, terminalId, before: welcome.snapshot };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

describe("Terminal 제목·창 배치 — Node/Spring 공통", () => {
  it.each(["open", "exited", "offline", "pending"] as const)(
    "%s: 입력 차단·다른 참여자의 제어권 중에도 제목·배치를 모든 참여자와 후속 snapshot에 반영한다",
    async (state) => {
      await using fixture = await viewFixture(state);
      const { observer, bob, terminalId, before } = fixture;

      const renamed = await request(bob, rename("  API logs  ", terminalId));
      const observedRename = await observer.next();
      const moved = await request(bob, move(geometry, terminalId));
      const observedMove = await observer.next();
      const after = (await fixture.join("late", "participant")).welcome.snapshot;

      expect(renamed).toEqual({
        type: "room-event",
        event: {
          kind: "terminal-renamed",
          terminalId,
          title: "API logs",
        },
      });
      expect(observedRename).toEqual(renamed);
      expect(moved).toEqual({
        type: "room-event",
        event: {
          kind: "terminal-geometry-changed",
          terminalId,
          geometry,
        },
      });
      expect(observedMove).toEqual(moved);
      expect(after.terminals).toEqual(
        before.terminals.map((t) => ({ ...t, title: "API logs", geometry })),
      );
      expect(after.leases).toEqual(before.leases);
    },
  );

  it("같은 제목은 알리지 않고 같은 geometry는 요청마다 알린다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);

    fixture.observer.send(rename("  term-7  "));
    const unchanged = await boundary(fixture.observer);
    const first = await request(fixture.observer, move());
    const second = await request(fixture.observer, move());

    expect(unchanged).toMatchObject({ type: "lease-invalid", terminalId: 0xfffffffe });
    expect(first).toMatchObject({ event: { kind: "terminal-geometry-changed", geometry } });
    expect(second).toEqual(first);
  });

  it.each([
    [
      "ECMAScript 공백",
      "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
      "API",
    ],
    ["제어문자는 보존", "\u001c", "\u001cAPI\u001c"],
    ["NEL은 보존", "\u0085", "\u0085API\u0085"],
    ["zero width는 보존", "\u200b", "\u200bAPI\u200b"],
  ])("제목 정규화: %s", async (_name, padding, expected) => {
    await using fixture = await protocolWorkspaceFixture([7]);

    const result = await request(fixture.observer, rename(`${padding}API${padding}`));

    expect(result).toMatchObject({ event: { kind: "terminal-renamed", title: expected } });
  });

  it("제목 길이는 trim 이후 UTF-16 80자 경계로 검증한다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const title = "😀".repeat(40);

    const accepted = await request(fixture.observer, rename(`  ${title}  `));
    const rejected = await request(fixture.observer, rename(title + "a"));
    const after = (await fixture.join("late", "participant")).welcome.snapshot;

    expect(accepted).toMatchObject({ event: { title } });
    expect(rejected).toMatchObject({ type: "error", code: "bad-message" });
    expect(after.terminals[0]).toMatchObject({ title });
  });

  it("없는 ID와 다른 방의 동일 ID에는 이벤트나 변경을 만들지 않는다", async () => {
    await using fixture = await protocolWorkspaceFixture([7]);
    const otherRoom = await fixture.server.room("other");
    const otherHost = (await fixture.join("host", "host", otherRoom)).peer;
    otherHost.send({
      type: "host-inventory",
      terminals: [{ terminalId: 7, runtimeId: "other-7", firstRetainedSeq: 0, lastOutputSeq: 0 }],
    });
    await otherHost.next();

    fixture.observer.send(rename("missing", 99));
    fixture.observer.send(move(geometry, 99));
    const missing = await boundary(fixture.observer);
    await request(fixture.observer, rename("only-here"));
    await request(fixture.observer, move());
    const other = (await fixture.join("other-reader", "participant", otherRoom)).welcome;

    expect(missing).toMatchObject({ type: "lease-invalid", terminalId: 0xfffffffe });
    expect(other.snapshot.terminals[0]).toMatchObject({
      title: "term-7",
      geometry: {
        x: 216,
        y: 216,
        width: 640,
        height: 420,
      },
    });
  });

  it("잘못된 제목·geometry·ID를 거절하고 상태를 보존한다", async () => {
    await using fixture = await viewFixture();
    const commands = [
      ...[undefined, null, 1, "", " \ufeff\u00a0 ", "a".repeat(81)].map((t) => rename(t)),
      ...[
        undefined,
        null,
        [],
        {},
        { ...geometry, x: "1" },
        { ...geometry, x: -65536 },
        { ...geometry, y: 65536 },
        { ...geometry, width: 0 },
        { ...geometry, height: -1 },
        { ...geometry, width: 65536 },
        { ...geometry, height: null },
      ].map((g) => ({ ...move(), geometry: g })),
      rename("bad", -1),
      move(geometry, 4294967296),
      rename("bad", 1.5),
      '{"type":"update-terminal-geometry","terminalId":7,"geometry":{"x":1e309,"y":0,"width":1,"height":1}}',
    ];

    const results = [];
    for (const command of commands) results.push(await request(fixture.observer, command));
    const after = (await fixture.join("late", "participant")).welcome.snapshot;

    expect(results).toEqual(
      commands.map(() => expect.objectContaining({ type: "error", code: "bad-message" })),
    );
    expect(after.terminals).toEqual(fixture.before.terminals);
  });

  it.each([rename("bad"), move()])("host 역할과 hello 전에는 $type을 거절한다", async (command) => {
    await using fixture = await protocolWorkspaceFixture([7]);
    await using stranger = await SocketProbe.connect(fixture.room.baseUrl);

    const host = await request(fixture.host, command);
    const unauthenticated = await request(stranger, command);

    expect([host, unauthenticated]).toMatchObject([
      { type: "error", code: "bad-message" },
      { type: "error", code: "bad-message" },
    ]);
  });
});

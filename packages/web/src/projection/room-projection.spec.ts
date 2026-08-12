import { describe, expect, it, vi } from "vitest";

import { RoomProjection } from "./room-projection.js";

import type { RoomSnapshot } from "@ttyroom/protocol";

const snapshot: RoomSnapshot = {
  roomId: "room-1",
  name: "Payment Debug",
  participants: [{ clientId: "alice-id", name: "Alice" }],
  hosts: [
    {
      hostId: "host-1",
      name: "Alice-Mac",
      online: true,
      remoteInputAllowed: true,
    },
  ],
  terminals: [
    {
      terminalId: 1,
      hostId: "host-1",
      title: "backend",
      mode: "exclusive",
      status: "open",
      exitCode: null,
      meta: { cwd: "/projects/api", gitBranch: "main", fgProcess: "node" },
    },
  ],
  leases: [],
};

describe("RoomProjection — authoritative Room state", () => {
  it("replaces the visible Room atomically when welcome arrives", () => {
    const projection = new RoomProjection();
    const subscriber = vi.fn();
    projection.subscribe(subscriber);

    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "alice-id",
      snapshot,
    });

    expect(projection.view()).toMatchObject({
      connection: "live",
      selfClientId: "alice-id",
      room: { roomId: "room-1", name: "Payment Debug" },
    });
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber.mock.calls[0]?.[0]).toMatchObject({
      connection: "live",
      selfClientId: "alice-id",
      room: { roomId: "room-1" },
    });
  });

  it("applies each Room event only to its authoritative entity", () => {
    const projection = welcomedProjection();

    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "participant-joined", participant: { clientId: "bob-id", name: "Bob" } },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "host-connected",
        host: {
          hostId: "host-2",
          name: "Bob-Mac",
          online: true,
          remoteInputAllowed: true,
        },
      },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "terminal-opened",
        terminal: {
          terminalId: 2,
          hostId: "host-2",
          title: "frontend",
          mode: "exclusive",
          status: "open",
          exitCode: null,
          meta: { cwd: null, gitBranch: null, fgProcess: null },
        },
      },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "lease-granted",
        lease: { terminalId: 2, leaseId: 7, holderClientId: "bob-id" },
      },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "terminal-meta",
        terminalId: 1,
        meta: { cwd: "/next", gitBranch: "feature", fgProcess: "vitest" },
      },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "terminal-mode-changed", terminalId: 1, mode: "shared" },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "host-input-state-changed",
        hostId: "host-1",
        remoteInputAllowed: false,
      },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "host-offline", hostId: "host-1" },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "terminal-closed", terminalId: 1, exitCode: 12 },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "lease-released", terminalId: 2 },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "participant-left", clientId: "bob-id" },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "host-removed", hostId: "host-2" },
    });

    expect(projection.view().room).toEqual({
      ...snapshot,
      participants: snapshot.participants,
      hosts: [{ ...snapshot.hosts[0], online: false, remoteInputAllowed: false }],
      terminals: [
        {
          ...snapshot.terminals[0],
          mode: "shared",
          status: "exited",
          exitCode: 12,
          meta: { cwd: "/next", gitBranch: "feature", fgProcess: "vitest" },
        },
        {
          terminalId: 2,
          hostId: "host-2",
          title: "frontend",
          mode: "exclusive",
          status: "open",
          exitCode: null,
          meta: { cwd: null, gitBranch: null, fgProcess: null },
        },
      ],
      leases: [],
    });
  });

  it("derives input capability from terminal, host, lease, holder, and self state", () => {
    const projection = welcomedProjection();

    expect(projection.terminal(1)?.inputCapability).toEqual({ kind: "available" });

    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "lease-granted",
        lease: { terminalId: 1, leaseId: 4, holderClientId: "alice-id" },
      },
    });
    expect(projection.terminal(1)?.inputCapability).toEqual({ kind: "mine", leaseId: 4 });

    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "participant-joined", participant: { clientId: "bob-id", name: "Bob" } },
    });
    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "lease-granted",
        lease: { terminalId: 1, leaseId: 5, holderClientId: "bob-id" },
      },
    });
    expect(projection.terminal(1)).toMatchObject({
      holder: { clientId: "bob-id", name: "Bob" },
      inputCapability: { kind: "held-by-other", holderName: "Bob" },
    });

    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "terminal-mode-changed", terminalId: 1, mode: "shared" },
    });
    expect(projection.terminal(1)?.inputCapability).toEqual({ kind: "shared" });

    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "host-input-state-changed",
        hostId: "host-1",
        remoteInputAllowed: false,
      },
    });
    expect(projection.terminal(1)?.inputCapability).toEqual({
      kind: "read-only",
      reason: "host-disabled",
    });
  });

  it("ignores an event for an unknown terminal and returns a diagnostic", () => {
    const projection = welcomedProjection();
    const before = projection.view();
    const subscriber = vi.fn();
    projection.subscribe(subscriber);

    const effects = projection.applyServerMessage({
      type: "room-event",
      event: { kind: "terminal-mode-changed", terminalId: 999, mode: "shared" },
    });

    expect(effects).toEqual([{ kind: "diagnostic", code: "unknown-terminal", terminalId: 999 }]);
    expect(projection.view()).toEqual(before);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("publishes deeply immutable snapshots that later events cannot mutate", () => {
    const projection = new RoomProjection();
    const observed: Array<ReturnType<RoomProjection["view"]>> = [];
    projection.subscribe((view) => observed.push(view));

    projection.applyServerMessage({
      type: "welcome",
      selfClientId: "alice-id",
      snapshot,
    });
    const welcomeView = observed[0];
    if (!welcomeView?.room) throw new Error("Expected welcome Room view");

    projection.applyServerMessage({
      type: "room-event",
      event: { kind: "participant-joined", participant: { clientId: "bob-id", name: "Bob" } },
    });

    expect(Object.isFrozen(welcomeView)).toBe(true);
    expect(Object.isFrozen(welcomeView.room)).toBe(true);
    expect(Object.isFrozen(welcomeView.room.participants)).toBe(true);
    expect(Object.isFrozen(welcomeView.room.participants[0])).toBe(true);
    expect(welcomeView.room.participants).toEqual([{ clientId: "alice-id", name: "Alice" }]);
  });

  it("publishes continuous output exactly once", () => {
    const projection = welcomedProjection();
    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 0 });

    const frame = {
      kind: "output" as const,
      terminalId: 1,
      seq: 1,
      payload: new Uint8Array([65]),
    };

    expect(projection.applyOutput(frame)).toEqual([
      {
        kind: "terminal-output",
        terminalId: 1,
        seq: 1,
        bytes: new Uint8Array([65]),
        replace: false,
      },
    ]);
    expect(projection.applyOutput(frame)).toEqual([]);
    expect(projection.terminal(1)?.output).toEqual({ status: "live", lastSeq: 1 });
  });

  it("marks only the gapped terminal restoring and requests retained replay", () => {
    const projection = welcomedProjection();
    const firstTerminal = snapshot.terminals[0];
    if (!firstTerminal) throw new Error("Expected terminal fixture");
    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 0 });
    projection.applyServerMessage({
      type: "room-event",
      event: {
        kind: "terminal-opened",
        terminal: {
          ...firstTerminal,
          terminalId: 2,
          title: "frontend",
        },
      },
    });

    expect(
      projection.applyServerMessage({
        type: "output-gap",
        terminalId: 1,
        fromSeq: 2,
        toSeq: 4,
      }),
    ).toEqual([
      { kind: "reset-terminal-output", terminalId: 1 },
      { kind: "request-output-replay", terminalId: 1 },
    ]);
    expect(projection.terminal(1)?.output.status).toBe("restoring");
    expect(projection.terminal(2)?.output.status).toBe("live");
  });

  it("replaces output with contiguous retained replay and becomes live only at exact sync", () => {
    const projection = welcomedProjection();
    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 0 });
    projection.applyOutput({
      kind: "output",
      terminalId: 1,
      seq: 1,
      payload: new Uint8Array([65]),
    });
    projection.applyServerMessage({
      type: "output-gap",
      terminalId: 1,
      fromSeq: 2,
      toSeq: 3,
    });

    expect(
      projection.applyOutput({
        kind: "output",
        terminalId: 1,
        seq: 1,
        payload: new Uint8Array([65]),
      }),
    ).toMatchObject([{ kind: "terminal-output", seq: 1, replace: true }]);
    projection.applyOutput({
      kind: "output",
      terminalId: 1,
      seq: 2,
      payload: new Uint8Array([66]),
    });
    projection.applyOutput({
      kind: "output",
      terminalId: 1,
      seq: 3,
      payload: new Uint8Array([67]),
    });

    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 2 });
    expect(projection.terminal(1)?.output.status).toBe("restoring");

    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 3 });
    expect(projection.terminal(1)?.output).toEqual({ status: "live", lastSeq: 3 });
  });

  it("rewinds once when a live frame races ahead of retained replay after an output gap", () => {
    const projection = welcomedProjection();
    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 0 });
    projection.applyServerMessage({
      type: "output-gap",
      terminalId: 1,
      fromSeq: 1,
      toSeq: 2,
    });

    expect(
      projection.applyOutput({
        kind: "output",
        terminalId: 1,
        seq: 3,
        payload: new Uint8Array([67]),
      }),
    ).toMatchObject([{ seq: 3, replace: true }]);
    expect(
      projection.applyOutput({
        kind: "output",
        terminalId: 1,
        seq: 1,
        payload: new Uint8Array([65]),
      }),
    ).toMatchObject([{ seq: 1, replace: true }]);
    expect(
      projection.applyOutput({
        kind: "output",
        terminalId: 1,
        seq: 2,
        payload: new Uint8Array([66]),
      }),
    ).toMatchObject([{ seq: 2, replace: false }]);
    expect(
      projection.applyOutput({
        kind: "output",
        terminalId: 1,
        seq: 3,
        payload: new Uint8Array([67]),
      }),
    ).toMatchObject([{ seq: 3, replace: false }]);

    projection.applyServerMessage({ type: "sync", terminalId: 1, seq: 3 });
    expect(projection.terminal(1)?.output).toEqual({ status: "live", lastSeq: 3 });
  });
});

function welcomedProjection(): RoomProjection {
  const projection = new RoomProjection();
  projection.applyServerMessage({
    type: "welcome",
    selfClientId: "alice-id",
    snapshot,
  });
  return projection;
}

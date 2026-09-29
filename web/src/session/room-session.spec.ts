import { describe, expect, it, vi } from "vitest";

import { RoomProjection } from "../projection/room-projection.js";
import { RoomSession, type RoomSessionEvent } from "./room-session.js";

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type HelloMessage,
  type InputFrame,
  type ServerMessage,
} from "@ttyroom/protocol";
import type {
  SessionClock,
  SessionTransport,
  SessionTransportEvent,
  SessionTransportFactory,
} from "./room-session.js";

describe("RoomSession — collaborative Room lifecycle", () => {
  it("starts one participant transport with stable hello identity and applies welcome", () => {
    const { projection, transports } = startRoomSession();

    expect(transports.hellos).toEqual([
      {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        roomId: "room-1",
        token: "secret-token",
        clientId: "alice-id",
        name: "Alice",
        role: "participant",
      },
    ]);
    expect(transports.latest().startCount).toBe(1);

    welcome(transports);

    expect(projection.view()).toMatchObject({
      connection: "live",
      selfClientId: "alice-id",
      room: { roomId: "room-1", name: "Payment Debug" },
    });
  });

  it("reconnects with the same client identity using bounded injected delays", () => {
    const { clock, projection, transports } = startRoomSession();

    disconnect(transports);

    expect(projection.view().connection).toBe("reconnecting");
    expect(clock.delays).toEqual([100]);

    clock.fireNext();
    disconnect(transports);
    clock.fireNext();
    disconnect(transports);

    expect(clock.delays).toEqual([100, 200, 200]);
    expect(transports.hellos.map((hello) => hello.clientId)).toEqual([
      "alice-id",
      "alice-id",
      "alice-id",
    ]);
  });

  it("ends reconnect when the server reports that the Room is gone", () => {
    const { clock, projection, transports } = startRoomSession();

    receiveServerMessage(transports, {
      type: "error",
      code: "room-not-found",
      message: "room-not-found",
    });
    disconnect(transports);

    expect(projection.view().connection).toBe("gone");
    expect(clock.delays).toEqual([]);
    expect(transports.latest().disposeCount).toBe(1);
  });

  it("sends acquire only for explicit Take control and keeps ownership authoritative", () => {
    const { projection, session, transports } = startRoomSession();
    welcome(transports);

    expect(transports.latest().controls).toEqual([]);

    session.takeControl(1);

    expect(transports.latest().controls).toEqual([{ type: "acquire-lease", terminalId: 1 }]);
    expect(session.pendingControlTerminalId()).toBe(1);
    expect(projection.terminal(1)?.inputCapability).toEqual({ kind: "available" });
  });

  it("switches control by releasing the current lease before acquiring the target", () => {
    const { session, transports } = startRoomSession();
    welcome(transports, {
      ...roomSnapshot(),
      leases: [{ terminalId: 1, leaseId: 7, holderClientId: "alice-id" }],
    });

    session.takeControl(2);

    expect(transports.latest().controls).toEqual([
      { type: "release-lease", terminalId: 1, leaseId: 7 },
      { type: "acquire-lease", terminalId: 2 },
    ]);
  });

  it("releases only the current user's lease for an explicit Esc release", () => {
    const { session, transports } = startRoomSession();
    welcome(transports, {
      ...roomSnapshot(),
      leases: [{ terminalId: 1, leaseId: 7, holderClientId: "alice-id" }],
    });

    session.releaseControl(1);
    session.releaseControl(2);

    expect(transports.latest().controls).toEqual([
      { type: "release-lease", terminalId: 1, leaseId: 7 },
    ]);
  });

  it("maps terminal commands to public protocol controls", () => {
    const { session, transports } = startRoomSession();

    session.openTerminal("host-1");
    session.closeTerminal(1);
    session.setMode(1, "shared");
    session.resize(1, 120, 40);
    session.updateGeometry(1, { x: 160, y: 88, width: 720, height: 480 });
    session.renameTerminal(1, "API logs");

    expect(transports.latest().controls).toEqual([
      { type: "open-terminal-request", hostId: "host-1" },
      { type: "close-terminal-request", terminalId: 1 },
      { type: "set-terminal-mode", terminalId: 1, mode: "shared" },
      { type: "resize-request", terminalId: 1, cols: 120, rows: 40 },
      {
        type: "update-terminal-geometry",
        terminalId: 1,
        geometry: { x: 160, y: 88, width: 720, height: 480 },
      },
      { type: "rename-terminal", terminalId: 1, title: "API logs" },
    ]);
  });

  it("shares ephemeral canvas cursor positions and publishes remote cursor updates", () => {
    const subscriber = vi.fn();
    const { session, transports } = startRoomSession(subscriber);

    session.moveCursor({ x: 120.5, y: -48.25 });
    session.moveCursor(null);

    expect(transports.latest().controls).toEqual([
      { type: "move-cursor", position: { x: 120.5, y: -48.25 } },
      { type: "move-cursor", position: null },
    ]);

    receiveServerMessage(transports, {
      type: "participant-cursor",
      clientId: "bob-id",
      position: { x: 32, y: 64 },
    });

    expect(subscriber).toHaveBeenCalledWith({
      kind: "participant-cursor",
      clientId: "bob-id",
      position: { x: 32, y: 64 },
    });
  });

  it("reports the desired terminal focus after welcome and restores it after reconnect", () => {
    const { clock, session, transports } = startRoomSession();

    session.focusTerminal(2);
    expect(transports.latest().controls).toEqual([]);

    welcome(transports);
    expect(transports.latest().controls).toEqual([{ type: "focus-terminal", terminalId: 2 }]);

    session.focusTerminal(1);
    expect(transports.latest().controls.at(-1)).toEqual({
      type: "focus-terminal",
      terminalId: 1,
    });

    disconnect(transports);
    clock.fireNext();
    expect(transports.latest().controls).toEqual([]);
    welcome(transports);
    expect(transports.latest().controls).toEqual([{ type: "focus-terminal", terminalId: 1 }]);
  });

  it("publishes typed lease denial and invalid feedback with the current holder name", () => {
    const subscriber = vi.fn();
    const { transports } = startRoomSession(subscriber);
    welcome(transports, {
      ...roomSnapshot(),
      participants: [
        { clientId: "alice-id", name: "Alice", focusedTerminalId: null },
        { clientId: "bob-id", name: "Bob", focusedTerminalId: null },
      ],
    });

    receiveServerMessage(transports, {
      type: "lease-result",
      terminalId: 1,
      result: { kind: "denied", holderClientId: "bob-id" },
    });
    receiveServerMessage(transports, {
      type: "lease-invalid",
      terminalId: 1,
      reason: "remote-input-disabled",
    });

    expect(subscriber.mock.calls.map((call) => call[0])).toEqual([
      { kind: "lease-denied", terminalId: 1, holderName: "Bob" },
      { kind: "lease-invalid", terminalId: 1, reason: "remote-input-disabled" },
    ]);
  });

  it("publishes successful explicit control acquisition for user feedback", () => {
    const subscriber = vi.fn();
    const { transports } = startRoomSession(subscriber);

    welcome(transports);
    receiveServerMessage(transports, {
      type: "lease-result",
      terminalId: 1,
      result: { kind: "granted", leaseId: 9 },
    });

    expect(subscriber).toHaveBeenCalledWith({ kind: "lease-acquired", terminalId: 1 });
  });

  it("requests replay on output gap and replaces the terminal buffer with retained output", () => {
    const subscriber = vi.fn();
    const { transports } = startRoomSession(subscriber);
    welcome(transports);
    receiveServerMessage(transports, { type: "sync", terminalId: 1, seq: 0 });
    receiveOutput(transports, 1, 1, [65]);

    receiveServerMessage(transports, {
      type: "output-gap",
      terminalId: 1,
      fromSeq: 2,
      toSeq: 3,
    });
    receiveOutput(transports, 1, 1, [65]);

    expect(transports.latest().controls).toEqual([
      { type: "resync-output-request", terminalId: 1 },
    ]);
    expect(subscriber.mock.calls.map((call) => call[0])).toEqual([
      {
        kind: "terminal-output",
        terminalId: 1,
        seq: 1,
        bytes: new Uint8Array([65]),
        replace: false,
      },
      { kind: "reset-terminal-output", terminalId: 1 },
      {
        kind: "terminal-output",
        terminalId: 1,
        seq: 1,
        bytes: new Uint8Array([65]),
        replace: true,
      },
    ]);
  });

  it("sends sequenced input only for mine or shared capability", () => {
    const { session, transports } = startRoomSession();
    welcome(transports, {
      ...roomSnapshot(),
      terminals: roomSnapshot().terminals.map((terminal) =>
        terminal.terminalId === 2 ? { ...terminal, mode: "shared" } : terminal,
      ),
      leases: [{ terminalId: 1, leaseId: 7, holderClientId: "alice-id" }],
    });
    receiveServerMessage(transports, { type: "sync", terminalId: 1, seq: 0 });
    receiveServerMessage(transports, { type: "sync", terminalId: 2, seq: 0 });

    expect(session.sendInput(1, new Uint8Array([65]))).toEqual({ kind: "sent", seq: 1 });
    expect(session.sendInput(2, new Uint8Array([66]))).toEqual({ kind: "sent", seq: 1 });
    expect(session.sendInput(999, new Uint8Array([67]))).toEqual({
      kind: "rejected",
      reason: "no-control",
    });
    expect(transports.latest().inputs).toEqual([
      { kind: "input", terminalId: 1, seq: 1, leaseId: 7, payload: new Uint8Array([65]) },
      { kind: "input", terminalId: 2, seq: 1, leaseId: 0, payload: new Uint8Array([66]) },
    ]);
  });

  it("stops idempotently by cancelling reconnect and disposing the active transport", () => {
    const { clock, session: reconnecting, transports } = startRoomSession();
    disconnect(transports);

    reconnecting.stop();
    reconnecting.stop();
    clock.fireNext();

    expect(clock.cancelCount).toBe(1);
    expect(transports.transports).toHaveLength(1);
    expect(transports.transports[0]?.disposeCount).toBe(1);

    const { session: active, transports: activeTransports } = startRoomSession();
    active.stop();
    active.stop();

    expect(activeTransports.latest().disposeCount).toBe(1);
  });
});

class FakeSessionTransport implements SessionTransport {
  startCount = 0;
  disposeCount = 0;
  readonly controls: ClientMessage[] = [];
  readonly inputs: InputFrame[] = [];
  private subscriber: ((event: SessionTransportEvent) => void) | null = null;

  start(): void {
    this.startCount += 1;
  }

  sendControl(message: ClientMessage): void {
    this.controls.push(message);
  }

  sendInput(frame: InputFrame): void {
    this.inputs.push(frame);
  }

  subscribe(subscriber: (event: SessionTransportEvent) => void): () => void {
    this.subscriber = subscriber;
    return () => {
      this.subscriber = null;
    };
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  emit(event: SessionTransportEvent): void {
    this.subscriber?.(event);
  }
}

class FakeSessionTransportFactory implements SessionTransportFactory {
  readonly hellos: HelloMessage[] = [];
  readonly transports: FakeSessionTransport[] = [];

  create(hello: HelloMessage): FakeSessionTransport {
    const transport = new FakeSessionTransport();
    this.hellos.push(hello);
    this.transports.push(transport);
    return transport;
  }

  latest(): FakeSessionTransport {
    const transport = this.transports.at(-1);
    if (!transport) throw new Error("Expected Session transport");
    return transport;
  }
}

class ManualSessionClock implements SessionClock {
  readonly delays: number[] = [];
  readonly callbacks: Array<() => void> = [];
  cancelCount = 0;

  schedule(delayMs: number, callback: () => void): () => void {
    this.delays.push(delayMs);
    this.callbacks.push(callback);
    return () => {
      this.cancelCount += 1;
    };
  }

  fireNext(): void {
    const callback = this.callbacks.shift();
    if (!callback) throw new Error("Expected scheduled callback");
    callback();
  }
}

function startRoomSession(subscriber?: (event: RoomSessionEvent) => void): {
  projection: RoomProjection;
  transports: FakeSessionTransportFactory;
  clock: ManualSessionClock;
  session: RoomSession;
} {
  const projection = new RoomProjection();
  const transports = new FakeSessionTransportFactory();
  const clock = new ManualSessionClock();
  const session = createSession({ projection, transports, clock });
  if (subscriber) session.subscribe(subscriber);
  session.start();
  return { projection, transports, clock, session };
}

function createSession(options: {
  projection: RoomProjection;
  transports: FakeSessionTransportFactory;
  clock?: ManualSessionClock;
}): RoomSession {
  return new RoomSession(
    {
      projection: options.projection,
      transportFactory: options.transports,
      clock: options.clock ?? new ManualSessionClock(),
    },
    {
      identity: {
        roomId: "room-1",
        token: "secret-token",
        clientId: "alice-id",
        name: "Alice",
      },
      reconnectDelaysMs: [100, 200],
    },
  );
}

function welcome(transports: FakeSessionTransportFactory, snapshot = roomSnapshot()): void {
  receiveServerMessage(transports, {
    type: "welcome",
    selfClientId: "alice-id",
    snapshot,
  });
}

function receiveServerMessage(
  transports: FakeSessionTransportFactory,
  message: ServerMessage,
): void {
  transports.latest().emit({ kind: "server-message", message });
}

function receiveOutput(
  transports: FakeSessionTransportFactory,
  terminalId: number,
  seq: number,
  bytes: number[],
): void {
  transports.latest().emit({
    kind: "output",
    frame: { kind: "output", terminalId, seq, payload: new Uint8Array(bytes) },
  });
}

function disconnect(transports: FakeSessionTransportFactory): void {
  transports.latest().emit({ kind: "closed" });
}

function roomSnapshot(): Extract<ServerMessage, { type: "welcome" }>["snapshot"] {
  return {
    roomId: "room-1",
    name: "Payment Debug",
    participants: [{ clientId: "alice-id", name: "Alice", focusedTerminalId: null }],
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
        geometry: { x: 24, y: 24, width: 640, height: 420 },
        mode: "exclusive",
        status: "open",
        exitCode: null,
        meta: { cwd: "/projects/api", gitBranch: "main", fgProcess: "node" },
      },
      {
        terminalId: 2,
        hostId: "host-1",
        title: "tests",
        geometry: { x: 56, y: 56, width: 640, height: 420 },
        mode: "exclusive",
        status: "open",
        exitCode: null,
        meta: { cwd: "/projects/api", gitBranch: "main", fgProcess: "vitest" },
      },
    ],
    leases: [],
  };
}

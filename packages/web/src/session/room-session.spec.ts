import { describe, expect, it, vi } from "vitest";

import { RoomProjection } from "../projection/room-projection.js";
import { RoomSession } from "./room-session.js";

import type { ClientMessage, HelloMessage, InputFrame, ServerMessage } from "@ttyroom/protocol";
import type {
  SessionClock,
  SessionTransport,
  SessionTransportEvent,
  SessionTransportFactory,
} from "./room-session.js";

describe("RoomSession — collaborative Room lifecycle", () => {
  it("starts one participant transport with stable hello identity and applies welcome", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });

    session.start();

    expect(transports.hellos).toEqual([
      {
        type: "hello",
        protocolVersion: 2,
        roomId: "room-1",
        token: "secret-token",
        clientId: "alice-id",
        name: "Alice",
        role: "participant",
      },
    ]);
    expect(transports.latest().startCount).toBe(1);

    transports.latest().emit({
      kind: "server-message",
      message: { type: "welcome", selfClientId: "alice-id", snapshot: roomSnapshot() },
    });

    expect(projection.view()).toMatchObject({
      connection: "live",
      selfClientId: "alice-id",
      room: { roomId: "room-1", name: "Payment Debug" },
    });
  });

  it("reconnects with the same client identity using bounded injected delays", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const clock = new ManualSessionClock();
    const session = createSession({ projection, transports, clock });
    session.start();

    transports.latest().emit({ kind: "closed" });

    expect(projection.view().connection).toBe("reconnecting");
    expect(clock.delays).toEqual([100]);

    clock.fireNext();
    transports.latest().emit({ kind: "closed" });
    clock.fireNext();
    transports.latest().emit({ kind: "closed" });

    expect(clock.delays).toEqual([100, 200, 200]);
    expect(transports.hellos.map((hello) => hello.clientId)).toEqual([
      "alice-id",
      "alice-id",
      "alice-id",
    ]);
  });

  it("ends reconnect when the server reports that the Room is gone", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const clock = new ManualSessionClock();
    const session = createSession({ projection, transports, clock });
    session.start();

    transports.latest().emit({
      kind: "server-message",
      message: { type: "error", code: "room-not-found", message: "room-not-found" },
    });
    transports.latest().emit({ kind: "closed" });

    expect(projection.view().connection).toBe("gone");
    expect(clock.delays).toEqual([]);
    expect(transports.latest().disposeCount).toBe(1);
  });

  it("sends acquire only for explicit Take control and keeps ownership authoritative", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });
    session.start();
    transports.latest().emit({
      kind: "server-message",
      message: { type: "welcome", selfClientId: "alice-id", snapshot: roomSnapshot() },
    });

    expect(transports.latest().controls).toEqual([]);

    session.takeControl(1);

    expect(transports.latest().controls).toEqual([{ type: "acquire-lease", terminalId: 1 }]);
    expect(session.pendingControlTerminalId()).toBe(1);
    expect(projection.terminal(1)?.inputCapability).toEqual({ kind: "available" });
  });

  it("switches control by releasing the current lease before acquiring the target", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });
    session.start();
    transports.latest().emit({
      kind: "server-message",
      message: {
        type: "welcome",
        selfClientId: "alice-id",
        snapshot: {
          ...roomSnapshot(),
          leases: [{ terminalId: 1, leaseId: 7, holderClientId: "alice-id" }],
        },
      },
    });

    session.takeControl(2);

    expect(transports.latest().controls).toEqual([
      { type: "release-lease", terminalId: 1, leaseId: 7 },
      { type: "acquire-lease", terminalId: 2 },
    ]);
  });

  it("releases only the current user's lease for an explicit Esc release", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });
    session.start();
    transports.latest().emit({
      kind: "server-message",
      message: {
        type: "welcome",
        selfClientId: "alice-id",
        snapshot: {
          ...roomSnapshot(),
          leases: [{ terminalId: 1, leaseId: 7, holderClientId: "alice-id" }],
        },
      },
    });

    session.releaseControl(1);
    session.releaseControl(2);

    expect(transports.latest().controls).toEqual([
      { type: "release-lease", terminalId: 1, leaseId: 7 },
    ]);
  });

  it("maps terminal commands to public protocol v2 controls", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });
    session.start();

    session.openTerminal("host-1");
    session.closeTerminal(1);
    session.setMode(1, "shared");
    session.resize(1, 120, 40);

    expect(transports.latest().controls).toEqual([
      { type: "open-terminal-request", hostId: "host-1" },
      { type: "close-terminal-request", terminalId: 1 },
      { type: "set-terminal-mode", terminalId: 1, mode: "shared" },
      { type: "resize-request", terminalId: 1, cols: 120, rows: 40 },
    ]);
  });

  it("publishes typed lease denial and invalid feedback with the current holder name", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });
    const subscriber = vi.fn();
    session.subscribe(subscriber);
    session.start();
    transports.latest().emit({
      kind: "server-message",
      message: {
        type: "welcome",
        selfClientId: "alice-id",
        snapshot: {
          ...roomSnapshot(),
          participants: [
            { clientId: "alice-id", name: "Alice" },
            { clientId: "bob-id", name: "Bob" },
          ],
        },
      },
    });

    transports.latest().emit({
      kind: "server-message",
      message: {
        type: "lease-result",
        terminalId: 1,
        result: { kind: "denied", holderClientId: "bob-id" },
      },
    });
    transports.latest().emit({
      kind: "server-message",
      message: { type: "lease-invalid", terminalId: 1, reason: "remote-input-disabled" },
    });

    expect(subscriber.mock.calls.map((call) => call[0])).toEqual([
      { kind: "lease-denied", terminalId: 1, holderName: "Bob" },
      { kind: "lease-invalid", terminalId: 1, reason: "remote-input-disabled" },
    ]);
  });

  it("requests replay on output gap and replaces the terminal buffer with retained output", () => {
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });
    const subscriber = vi.fn();
    session.subscribe(subscriber);
    session.start();
    transports.latest().emit({
      kind: "server-message",
      message: { type: "welcome", selfClientId: "alice-id", snapshot: roomSnapshot() },
    });
    transports.latest().emit({
      kind: "server-message",
      message: { type: "sync", terminalId: 1, seq: 0 },
    });
    transports.latest().emit({
      kind: "output",
      frame: {
        kind: "output",
        terminalId: 1,
        seq: 1,
        payload: new Uint8Array([65]),
      },
    });

    transports.latest().emit({
      kind: "server-message",
      message: { type: "output-gap", terminalId: 1, fromSeq: 2, toSeq: 3 },
    });
    transports.latest().emit({
      kind: "output",
      frame: {
        kind: "output",
        terminalId: 1,
        seq: 1,
        payload: new Uint8Array([65]),
      },
    });

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
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const session = createSession({ projection, transports });
    session.start();
    transports.latest().emit({
      kind: "server-message",
      message: {
        type: "welcome",
        selfClientId: "alice-id",
        snapshot: {
          ...roomSnapshot(),
          terminals: roomSnapshot().terminals.map((terminal) =>
            terminal.terminalId === 2 ? { ...terminal, mode: "shared" } : terminal,
          ),
          leases: [{ terminalId: 1, leaseId: 7, holderClientId: "alice-id" }],
        },
      },
    });
    transports.latest().emit({
      kind: "server-message",
      message: { type: "sync", terminalId: 1, seq: 0 },
    });
    transports.latest().emit({
      kind: "server-message",
      message: { type: "sync", terminalId: 2, seq: 0 },
    });

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
    const projection = new RoomProjection();
    const transports = new FakeSessionTransportFactory();
    const clock = new ManualSessionClock();
    const reconnecting = createSession({ projection, transports, clock });
    reconnecting.start();
    transports.latest().emit({ kind: "closed" });

    reconnecting.stop();
    reconnecting.stop();
    clock.fireNext();

    expect(clock.cancelCount).toBe(1);
    expect(transports.transports).toHaveLength(1);
    expect(transports.transports[0]?.disposeCount).toBe(1);

    const activeTransports = new FakeSessionTransportFactory();
    const active = createSession({
      projection: new RoomProjection(),
      transports: activeTransports,
    });
    active.start();
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

function roomSnapshot(): Extract<ServerMessage, { type: "welcome" }>["snapshot"] {
  return {
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
      {
        terminalId: 2,
        hostId: "host-1",
        title: "tests",
        mode: "exclusive",
        status: "open",
        exitCode: null,
        meta: { cwd: "/projects/api", gitBranch: "main", fgProcess: "vitest" },
      },
    ],
    leases: [],
  };
}

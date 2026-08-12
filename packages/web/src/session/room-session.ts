import { PROTOCOL_VERSION } from "@ttyroom/protocol";

import type {
  ClientMessage,
  HelloMessage,
  InputFrame,
  OutputFrame,
  ServerMessage,
  TerminalView,
} from "@ttyroom/protocol";
import type { ProjectionEffect, RoomProjection } from "../projection/room-projection.js";

export type SessionTransportEvent =
  | { kind: "server-message"; message: ServerMessage }
  | { kind: "output"; frame: OutputFrame }
  | {
      kind: "failure";
      reason: "malformed-control" | "malformed-data" | "socket-error";
    }
  | { kind: "closed" };

export interface SessionTransport {
  start(): void;
  sendControl(message: ClientMessage): void;
  sendInput(frame: InputFrame): void;
  subscribe(subscriber: (event: SessionTransportEvent) => void): () => void;
  dispose(): void;
}

export interface SessionTransportFactory {
  create(hello: HelloMessage): SessionTransport;
}

export interface SessionClock {
  schedule(delayMs: number, callback: () => void): () => void;
}

export type RoomSessionEvent =
  | { kind: "lease-acquired"; terminalId: number }
  | { kind: "lease-denied"; terminalId: number; holderName: string }
  | {
      kind: "lease-invalid";
      terminalId: number;
      reason: Extract<ServerMessage, { type: "lease-invalid" }>["reason"];
    }
  | {
      kind: "terminal-output";
      terminalId: number;
      seq: number;
      bytes: Uint8Array;
      replace: boolean;
    }
  | { kind: "reset-terminal-output"; terminalId: number };

type SessionSubscriber = (event: RoomSessionEvent) => void;

export type SendInputResult =
  | { kind: "sent"; seq: number }
  | {
      kind: "rejected";
      reason: "disconnected" | "no-control" | "read-only" | "restoring";
    };

export class RoomSession {
  private transport: SessionTransport | null = null;
  private unsubscribeTransport: (() => void) | null = null;
  private cancelReconnect: (() => void) | null = null;
  private reconnectAttempt = 0;
  private started = false;
  private pendingControl: number | null = null;
  private readonly subscribers = new Set<SessionSubscriber>();
  private readonly inputSeqByTerminal = new Map<number, number>();

  constructor(
    private readonly deps: {
      projection: RoomProjection;
      transportFactory: SessionTransportFactory;
      clock: SessionClock;
    },
    private readonly options: {
      identity: { roomId: string; token: string; clientId: string; name: string };
      reconnectDelaysMs: readonly number[];
    },
  ) {}

  start(): void {
    if (this.started) return;

    this.started = true;
    this.connect();
  }

  stop(): void {
    if (!this.started) return;

    this.started = false;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.transport?.dispose();
    this.transport = null;
    this.pendingControl = null;
    this.subscribers.clear();
  }

  takeControl(terminalId: number): void {
    if (!this.transport) return;

    const view = this.deps.projection.view();
    const currentLease = view.room?.leases.find(
      (lease) => lease.holderClientId === view.selfClientId,
    );
    if (currentLease?.terminalId === terminalId) return;
    if (currentLease) {
      this.transport.sendControl({
        type: "release-lease",
        terminalId: currentLease.terminalId,
        leaseId: currentLease.leaseId,
      });
    }

    this.pendingControl = terminalId;
    this.transport.sendControl({ type: "acquire-lease", terminalId });
  }

  pendingControlTerminalId(): number | null {
    return this.pendingControl;
  }

  releaseControl(terminalId: number): void {
    if (!this.transport) return;

    const capability = this.deps.projection.terminal(terminalId)?.inputCapability;
    if (capability?.kind !== "mine") return;

    this.transport.sendControl({
      type: "release-lease",
      terminalId,
      leaseId: capability.leaseId,
    });
  }

  openTerminal(hostId: string): void {
    this.transport?.sendControl({ type: "open-terminal-request", hostId });
  }

  closeTerminal(terminalId: number): void {
    this.transport?.sendControl({ type: "close-terminal-request", terminalId });
  }

  setMode(terminalId: number, mode: TerminalView["mode"]): void {
    this.transport?.sendControl({ type: "set-terminal-mode", terminalId, mode });
  }

  resize(terminalId: number, cols: number, rows: number): void {
    this.transport?.sendControl({ type: "resize-request", terminalId, cols, rows });
  }

  subscribe(subscriber: SessionSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  sendInput(terminalId: number, bytes: Uint8Array): SendInputResult {
    if (!this.transport || this.deps.projection.view().connection !== "live") {
      return { kind: "rejected", reason: "disconnected" };
    }

    const projected = this.deps.projection.terminal(terminalId);
    if (!projected) return { kind: "rejected", reason: "no-control" };
    if (projected.output.status === "restoring") {
      return { kind: "rejected", reason: "restoring" };
    }

    const capability = projected.inputCapability;
    if (capability.kind === "read-only") {
      return { kind: "rejected", reason: "read-only" };
    }
    if (capability.kind !== "mine" && capability.kind !== "shared") {
      return { kind: "rejected", reason: "no-control" };
    }

    const seq = (this.inputSeqByTerminal.get(terminalId) ?? 0) + 1;
    this.inputSeqByTerminal.set(terminalId, seq);
    this.transport.sendInput({
      kind: "input",
      terminalId,
      seq,
      leaseId: capability.kind === "mine" ? capability.leaseId : 0,
      payload: bytes.slice(),
    });
    return { kind: "sent", seq };
  }

  private connect(): void {
    const transport = this.deps.transportFactory.create({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      ...this.options.identity,
      role: "participant",
    });
    this.transport = transport;
    this.unsubscribeTransport = transport.subscribe((event) => this.handleTransport(event));
    transport.start();
  }

  private handleTransport(event: SessionTransportEvent): void {
    if (event.kind === "server-message") {
      const message = event.message;
      if (message.type === "error" && message.code === "room-not-found") {
        this.finish("gone");
        return;
      }
      if (message.type === "error" && message.code === "unsupported-protocol-version") {
        this.finish("incompatible");
        return;
      }
      if (message.type === "lease-result") this.pendingControl = null;
      if (message.type === "lease-result" && message.result.kind === "granted") {
        this.publish({ kind: "lease-acquired", terminalId: message.terminalId });
      }
      if (message.type === "lease-result" && message.result.kind === "denied") {
        const holderClientId = message.result.holderClientId;
        const holder = this.deps.projection
          .view()
          .room?.participants.find((participant) => participant.clientId === holderClientId);
        this.publish({
          kind: "lease-denied",
          terminalId: message.terminalId,
          holderName: holder?.name ?? holderClientId,
        });
      }
      if (message.type === "lease-invalid") {
        this.pendingControl = null;
        this.publish({
          kind: "lease-invalid",
          terminalId: message.terminalId,
          reason: message.reason,
        });
      }
      if (message.type === "welcome") {
        this.reconnectAttempt = 0;
        this.cancelReconnect?.();
        this.cancelReconnect = null;
      }
      this.handleProjectionEffects(this.deps.projection.applyServerMessage(message));
      return;
    }

    if (event.kind === "output") {
      this.handleProjectionEffects(this.deps.projection.applyOutput(event.frame));
      return;
    }

    if (event.kind === "closed") {
      this.scheduleReconnect();
    }
  }

  private publish(event: RoomSessionEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private handleProjectionEffects(effects: readonly ProjectionEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "request-output-replay":
          this.transport?.sendControl({
            type: "resync-output-request",
            terminalId: effect.terminalId,
          });
          break;
        case "terminal-output":
        case "reset-terminal-output":
          this.publish(effect);
          break;
        case "diagnostic":
          break;
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.cancelReconnect) return;
    const delays = this.options.reconnectDelaysMs;
    const lastDelay = delays.at(-1);
    if (lastDelay === undefined) {
      throw new Error("RoomSession requires at least one reconnect delay");
    }

    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.transport?.dispose();
    this.transport = null;
    this.deps.projection.setConnection("reconnecting");

    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? lastDelay;
    this.reconnectAttempt += 1;
    this.cancelReconnect = this.deps.clock.schedule(delay, () => {
      this.cancelReconnect = null;
      if (this.started) this.connect();
    });
  }

  private finish(connection: "gone" | "incompatible"): void {
    this.started = false;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.transport?.dispose();
    this.transport = null;
    this.pendingControl = null;
    this.deps.projection.setConnection(connection);
  }
}

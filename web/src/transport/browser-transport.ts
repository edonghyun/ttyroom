import {
  decodeDataFrame,
  encodeDataFrame,
  parseServerMessage,
  serializeClientMessage,
} from "@ttyroom/protocol";

import type {
  ClientMessage,
  CredentialHelloMessage,
  InputFrame,
  OutputFrame,
  ServerMessage,
} from "@ttyroom/protocol";
import type { BrowserSocket, BrowserSocketFactory } from "./browser-socket.js";

export interface BrowserTransportDeps {
  socketFactory: BrowserSocketFactory;
  locationHref: string;
}

export type BrowserTransportEvent =
  | { kind: "server-message"; message: ServerMessage }
  | { kind: "output"; frame: OutputFrame }
  | {
      kind: "failure";
      reason: "malformed-control" | "malformed-data" | "socket-error";
    }
  | { kind: "closed" };
type TransportSubscriber = (event: BrowserTransportEvent) => void;

export class BrowserTransport {
  private socket: BrowserSocket | null = null;
  private helloSent = false;
  private opened = false;
  private disposed = false;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly subscribers = new Set<TransportSubscriber>();

  constructor(
    private readonly deps: BrowserTransportDeps,
    private readonly options: { hello: CredentialHelloMessage },
  ) {}

  start(): void {
    if (this.socket || this.disposed) return;

    const endpoint = new URL("/ws", this.deps.locationHref);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    this.socket = this.deps.socketFactory.create(endpoint.href);
    this.unsubscribe.push(
      this.socket.onOpen(() => {
        if (this.helloSent) return;

        this.opened = true;
        this.helloSent = true;
        this.socket?.send(serializeClientMessage(this.options.hello));
      }),
      this.socket.onMessage((data) => {
        if (data instanceof ArrayBuffer) {
          const decoded = decodeDataFrame(new Uint8Array(data));
          if (decoded.kind === "ok" && decoded.frame.kind === "output") {
            this.publish({ kind: "output", frame: decoded.frame });
          } else {
            this.publish({ kind: "failure", reason: "malformed-data" });
          }
          return;
        }

        if (typeof data !== "string") return;

        const parsed = parseServerMessage(data);
        if (parsed.kind === "ok") {
          this.publish({ kind: "server-message", message: parsed.message });
        } else {
          this.publish({ kind: "failure", reason: "malformed-control" });
        }
      }),
      this.socket.onClose(() => {
        this.opened = false;
        this.publish({ kind: "closed" });
      }),
      this.socket.onError(() => this.publish({ kind: "failure", reason: "socket-error" })),
    );
  }

  subscribe(subscriber: TransportSubscriber): () => void {
    if (this.disposed) return () => undefined;

    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  sendControl(message: ClientMessage): void {
    if (!this.opened || this.disposed) return;

    this.socket?.send(serializeClientMessage(message));
  }

  sendInput(frame: InputFrame): void {
    if (!this.opened || this.disposed) return;

    this.socket?.send(new Uint8Array(encodeDataFrame(frame)).buffer);
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.opened = false;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.subscribers.clear();
    this.socket?.close();
    this.socket = null;
  }

  private publish(event: BrowserTransportEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

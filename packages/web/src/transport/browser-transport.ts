import { decodeDataFrame, parseServerMessage, serializeClientMessage } from "@ttyroom/protocol";

import type { HelloMessage, OutputFrame, ServerMessage } from "@ttyroom/protocol";
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
  private disposed = false;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly subscribers = new Set<TransportSubscriber>();

  constructor(
    private readonly deps: BrowserTransportDeps,
    private readonly options: { hello: HelloMessage },
  ) {}

  start(): void {
    if (this.socket || this.disposed) return;

    const endpoint = new URL("/ws", this.deps.locationHref);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    this.socket = this.deps.socketFactory.create(endpoint.href);
    this.unsubscribe.push(
      this.socket.onOpen(() => {
        if (this.helloSent) return;

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
      this.socket.onClose(() => this.publish({ kind: "closed" })),
      this.socket.onError(() => this.publish({ kind: "failure", reason: "socket-error" })),
    );
  }

  subscribe(subscriber: TransportSubscriber): () => void {
    if (this.disposed) return () => undefined;

    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.subscribers.clear();
    this.socket?.close();
    this.socket = null;
  }

  private publish(event: BrowserTransportEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

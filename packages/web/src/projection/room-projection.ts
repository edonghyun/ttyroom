import type {
  HostView,
  LeaseView,
  ParticipantView,
  RoomEvent,
  RoomSnapshot,
  ServerMessage,
  TerminalView,
} from "@ttyroom/protocol";

export type RoomConnectionState =
  | "joining"
  | "live"
  | "reconnecting"
  | "restoring"
  | "gone"
  | "incompatible";

export interface RoomProjectionView {
  readonly connection: RoomConnectionState;
  readonly selfClientId: string | null;
  readonly room: RoomSnapshot | null;
}

export type InputCapability =
  | { kind: "mine"; leaseId: number }
  | { kind: "available" }
  | { kind: "held-by-other"; holderName: string }
  | { kind: "shared" }
  | { kind: "read-only"; reason: "host-disabled" | "host-offline" | "exited" };

export interface ProjectedTerminal {
  readonly terminal: TerminalView;
  readonly host: HostView | null;
  readonly lease: LeaseView | null;
  readonly holder: ParticipantView | null;
  readonly inputCapability: InputCapability;
}

export type ProjectionEffect = {
  kind: "diagnostic";
  code: "unknown-terminal";
  terminalId: number;
};
type Subscriber = (view: RoomProjectionView) => void;

export class RoomProjection {
  private connection: RoomConnectionState = "joining";
  private selfClientId: string | null = null;
  private room: RoomSnapshot | null = null;
  private readonly subscribers = new Set<Subscriber>();

  view(): RoomProjectionView {
    return freezeView({
      connection: this.connection,
      selfClientId: this.selfClientId,
      room: this.room ? copyRoom(this.room) : null,
    });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  terminal(terminalId: number): ProjectedTerminal | null {
    const terminal = this.room?.terminals.find((item) => item.terminalId === terminalId);
    if (!terminal) return null;

    const host = this.room?.hosts.find((item) => item.hostId === terminal.hostId) ?? null;
    const lease = this.room?.leases.find((item) => item.terminalId === terminalId) ?? null;
    const holder =
      this.room?.participants.find((item) => item.clientId === lease?.holderClientId) ?? null;

    return {
      terminal: { ...terminal, meta: { ...terminal.meta } },
      host: host && { ...host },
      lease: lease && { ...lease },
      holder: holder && { ...holder },
      inputCapability: this.inputCapability(terminal, host, lease, holder),
    };
  }

  applyServerMessage(message: ServerMessage): readonly ProjectionEffect[] {
    if (message.type === "room-event") {
      const terminalId = existingTerminalTarget(message.event);
      if (
        terminalId !== null &&
        !this.room?.terminals.some((terminal) => terminal.terminalId === terminalId)
      ) {
        return [{ kind: "diagnostic", code: "unknown-terminal", terminalId }];
      }

      if (this.applyRoomEvent(message.event)) this.publish();
      return [];
    }

    if (message.type !== "welcome") return [];

    this.connection = "live";
    this.selfClientId = message.selfClientId;
    this.room = copyRoom(message.snapshot);
    this.publish();
    return [];
  }

  private applyRoomEvent(event: RoomEvent): boolean {
    if (!this.room) return false;

    switch (event.kind) {
      case "participant-joined":
        this.room.participants = replaceBy(
          this.room.participants,
          (participant) => participant.clientId === event.participant.clientId,
          event.participant,
        );
        return true;
      case "participant-left":
        this.room.participants = this.room.participants.filter(
          (participant) => participant.clientId !== event.clientId,
        );
        return true;
      case "host-connected":
        this.room.hosts = replaceBy(
          this.room.hosts,
          (host) => host.hostId === event.host.hostId,
          event.host,
        );
        return true;
      case "host-offline":
        return this.updateHost(event.hostId, (host) => ({ ...host, online: false }));
      case "host-removed":
        this.room.hosts = this.room.hosts.filter((host) => host.hostId !== event.hostId);
        return true;
      case "host-input-state-changed":
        return this.updateHost(event.hostId, (host) => ({
          ...host,
          remoteInputAllowed: event.remoteInputAllowed,
        }));
      case "terminal-opened":
        this.room.terminals = replaceBy(
          this.room.terminals,
          (terminal) => terminal.terminalId === event.terminal.terminalId,
          event.terminal,
        );
        return true;
      case "terminal-mode-changed":
        return this.updateTerminal(event.terminalId, (terminal) => ({
          ...terminal,
          mode: event.mode,
        }));
      case "terminal-closed":
        return this.updateTerminal(event.terminalId, (terminal) => ({
          ...terminal,
          status: "exited",
          exitCode: event.exitCode,
        }));
      case "terminal-meta":
        return this.updateTerminal(event.terminalId, (terminal) => ({
          ...terminal,
          meta: { ...event.meta },
        }));
      case "lease-granted":
        this.room.leases = replaceBy(
          this.room.leases,
          (lease) => lease.terminalId === event.lease.terminalId,
          event.lease,
        );
        return true;
      case "lease-released":
        this.room.leases = this.room.leases.filter(
          (lease) => lease.terminalId !== event.terminalId,
        );
        return true;
    }
  }

  private updateHost(
    hostId: string,
    update: (host: RoomSnapshot["hosts"][number]) => RoomSnapshot["hosts"][number],
  ): boolean {
    if (!this.room) return false;
    const index = this.room.hosts.findIndex((host) => host.hostId === hostId);
    const host = this.room.hosts[index];
    if (!host) return false;

    this.room.hosts[index] = update(host);
    return true;
  }

  private inputCapability(
    terminal: TerminalView,
    host: HostView | null,
    lease: LeaseView | null,
    holder: ParticipantView | null,
  ): InputCapability {
    if (terminal.status === "exited") return { kind: "read-only", reason: "exited" };
    if (!host?.online) return { kind: "read-only", reason: "host-offline" };
    if (!host.remoteInputAllowed) return { kind: "read-only", reason: "host-disabled" };
    if (terminal.mode === "shared") return { kind: "shared" };
    if (!lease) return { kind: "available" };
    if (lease.holderClientId === this.selfClientId) {
      return { kind: "mine", leaseId: lease.leaseId };
    }

    return { kind: "held-by-other", holderName: holder?.name ?? lease.holderClientId };
  }

  private updateTerminal(
    terminalId: number,
    update: (terminal: RoomSnapshot["terminals"][number]) => RoomSnapshot["terminals"][number],
  ): boolean {
    if (!this.room) return false;
    const index = this.room.terminals.findIndex((terminal) => terminal.terminalId === terminalId);
    const terminal = this.room.terminals[index];
    if (!terminal) return false;

    this.room.terminals[index] = update(terminal);
    return true;
  }

  private publish(): void {
    const view = this.view();
    for (const subscriber of this.subscribers) subscriber(view);
  }
}

function replaceBy<T>(items: T[], matches: (item: T) => boolean, replacement: T): T[] {
  const index = items.findIndex(matches);
  if (index === -1) return [...items, replacement];

  return items.map((item, itemIndex) => (itemIndex === index ? replacement : item));
}

function existingTerminalTarget(event: RoomEvent): number | null {
  switch (event.kind) {
    case "terminal-mode-changed":
    case "terminal-closed":
    case "terminal-meta":
    case "lease-released":
      return event.terminalId;
    case "lease-granted":
      return event.lease.terminalId;
    default:
      return null;
  }
}

function copyRoom(room: RoomSnapshot): RoomSnapshot {
  return {
    ...room,
    participants: room.participants.map((participant) => ({ ...participant })),
    hosts: room.hosts.map((host) => ({ ...host })),
    terminals: room.terminals.map((terminal) => ({
      ...terminal,
      meta: { ...terminal.meta },
    })),
    leases: room.leases.map((lease) => ({ ...lease })),
  };
}

function freezeView(view: RoomProjectionView): RoomProjectionView {
  if (view.room) {
    for (const participant of view.room.participants) Object.freeze(participant);
    for (const host of view.room.hosts) Object.freeze(host);
    for (const terminal of view.room.terminals) {
      Object.freeze(terminal.meta);
      Object.freeze(terminal);
    }
    for (const lease of view.room.leases) Object.freeze(lease);
    Object.freeze(view.room.participants);
    Object.freeze(view.room.hosts);
    Object.freeze(view.room.terminals);
    Object.freeze(view.room.leases);
    Object.freeze(view.room);
  }

  return Object.freeze(view);
}

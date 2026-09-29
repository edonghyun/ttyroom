import type { CancelTimer, Clock } from "../ports/clock.js";
import type { RoomRegistry } from "./room-registry.js";
import type { Policy } from "../ports/policy.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RoomEventPublisher } from "./room-event-publisher.js";

type SessionRole = "participant" | "host";

export interface DisconnectTask {
  roomId: string;
  role: SessionRole;
  clientId: string;
}

export class PendingDisconnects {
  private readonly timers = new Map<string, { cancel: CancelTimer; roomId: string }>();
  private readonly active = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly clock: Clock,
    private readonly onError: (error: unknown, task: DisconnectTask) => void = () => undefined,
  ) {}

  schedule(
    roomId: string,
    role: SessionRole,
    clientId: string,
    delayMs: number,
    onExpire: () => void | Promise<void>,
  ): void {
    if (this.closed) return;
    const key = this.key(roomId, role, clientId);
    this.cancel(roomId, role, clientId);
    const task = { roomId, role, clientId };
    const cancel = this.clock.schedule(delayMs, () => {
      this.timers.delete(key);
      return this.run(task, onExpire);
    });
    this.timers.set(key, { cancel, roomId });
  }

  cancel(roomId: string, role: SessionRole, clientId: string): void {
    const key = this.key(roomId, role, clientId);
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
  }

  hasForRoom(roomId: string): boolean {
    return [...this.timers.values()].some((timer) => timer.roomId === roomId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
    await Promise.all(this.active);
  }

  activeCount(): number {
    return this.active.size;
  }

  private run(task: DisconnectTask, onExpire: () => void | Promise<void>): Promise<void> {
    const active = Promise.resolve()
      .then(onExpire)
      .catch((error: unknown) => {
        try {
          this.onError(error, task);
        } catch {}
      });
    this.active.add(active);
    void active.then(
      () => this.active.delete(active),
      () => this.active.delete(active),
    );
    return active;
  }

  private key(roomId: string, role: SessionRole, clientId: string): string {
    return JSON.stringify([roomId, role, clientId]);
  }
}

export class HandleDisconnect {
  constructor(
    private readonly deps: {
      connections: ConnectionRegistry;
      events: RoomEventPublisher;
      pending: PendingDisconnects;
      rooms: RoomRegistry;
    },
    private readonly options: { policy: Policy },
  ) {}

  async execute(connection: Connection): Promise<void> {
    const session = this.deps.connections.unregister(connection.connectionId);
    if (!session) return;

    if (session.role === "participant") {
      this.deps.pending.schedule(
        session.roomId,
        "participant",
        session.clientId,
        this.options.policy.participantGraceMs,
        async () => {
          const room = this.deps.rooms.get(session.roomId);
          if (!room) return;
          const releasedLeases = await this.deps.rooms.change(room, (draft) =>
            draft.removeParticipant(session.clientId),
          );
          for (const lease of releasedLeases) {
            this.deps.events.publish(room.roomId, {
              kind: "lease-released",
              terminalId: lease.terminalId,
            });
          }
          this.deps.events.publish(room.roomId, {
            kind: "participant-left",
            clientId: session.clientId,
          });
          if (room.isEmpty() && !this.deps.pending.hasForRoom(room.roomId)) {
            await this.deps.rooms.remove(room.roomId);
          }
        },
      );
      return;
    }

    const hostId = session.hostId;
    const room = this.deps.rooms.get(session.roomId);
    if (!room) return;
    await this.deps.rooms.change(room, (draft) => draft.markHostOffline(hostId));
    this.deps.events.publish(room.roomId, { kind: "host-offline", hostId });
    this.deps.pending.schedule(
      room.roomId,
      "host",
      hostId,
      this.options.policy.hostGraceMs,
      async () => {
        const current = this.deps.rooms.get(session.roomId);
        if (!current) return;
        const terminalIds = await this.deps.rooms.change(current, (draft) =>
          draft.removeHost(hostId),
        );
        this.deps.events.publish(current.roomId, { kind: "host-removed", hostId });
        for (const terminalId of terminalIds) {
          this.deps.events.publish(current.roomId, {
            kind: "terminal-closed",
            terminalId,
            exitCode: null,
          });
        }
        if (current.isEmpty() && !this.deps.pending.hasForRoom(current.roomId)) {
          await this.deps.rooms.remove(current.roomId);
        }
      },
    );
  }
}

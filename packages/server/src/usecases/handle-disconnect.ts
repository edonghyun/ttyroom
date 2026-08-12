import type { CancelTimer, Clock } from "../ports/clock.js";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Policy } from "../ports/policy.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";

type SessionRole = "participant" | "host";

export class PendingDisconnects {
  private readonly timers = new Map<string, { cancel: CancelTimer; roomId: string }>();

  constructor(private readonly clock: Clock) {}

  schedule(
    roomId: string,
    role: SessionRole,
    clientId: string,
    delayMs: number,
    onExpire: () => void,
  ): void {
    const key = this.key(roomId, role, clientId);
    this.cancel(roomId, role, clientId);
    const cancel = this.clock.schedule(delayMs, () => {
      this.timers.delete(key);
      onExpire();
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

  private key(roomId: string, role: SessionRole, clientId: string): string {
    return JSON.stringify([roomId, role, clientId]);
  }
}

export class HandleDisconnect {
  constructor(
    private readonly deps: {
      connections: ConnectionRegistry;
      pending: PendingDisconnects;
      rooms: RoomRegistry;
    },
    private readonly options: { policy: Policy },
  ) {}

  execute(connection: Connection): void {
    const session = this.deps.connections.unregister(connection.connectionId);
    if (!session) return;

    if (session.role === "participant") {
      this.deps.pending.schedule(
        session.roomId,
        "participant",
        session.clientId,
        this.options.policy.participantGraceMs,
        () => {
          const room = this.deps.rooms.get(session.roomId);
          if (!room) return;
          for (const lease of room.removeParticipant(session.clientId)) {
            this.deps.connections.broadcast(room.roomId, {
              type: "room-event",
              event: { kind: "lease-released", terminalId: lease.terminalId },
            });
          }
          this.deps.connections.broadcast(room.roomId, {
            type: "room-event",
            event: { kind: "participant-left", clientId: session.clientId },
          });
          if (room.isEmpty() && !this.deps.pending.hasForRoom(room.roomId)) {
            this.deps.rooms.remove(room.roomId);
          }
        },
      );
      return;
    }

    if (!session.hostId) throw new Error("host 세션에 hostId가 없다");
    const hostId = session.hostId;
    const room = this.deps.rooms.get(session.roomId);
    if (!room) return;
    room.markHostOffline(hostId);
    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: { kind: "host-offline", hostId },
    });
    this.deps.pending.schedule(room.roomId, "host", hostId, this.options.policy.hostGraceMs, () => {
      const current = this.deps.rooms.get(session.roomId);
      if (!current) return;
      const terminalIds = current.removeHost(hostId);
      this.deps.connections.broadcast(current.roomId, {
        type: "room-event",
        event: { kind: "host-removed", hostId },
      });
      for (const terminalId of terminalIds) {
        this.deps.connections.broadcast(current.roomId, {
          type: "room-event",
          event: { kind: "terminal-closed", terminalId, exitCode: null },
        });
      }
      if (current.isEmpty() && !this.deps.pending.hasForRoom(current.roomId)) {
        this.deps.rooms.remove(current.roomId);
      }
    });
  }
}

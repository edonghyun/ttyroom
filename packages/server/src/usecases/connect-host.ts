import type { Room } from "../domain/room.js";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { PendingDisconnects } from "./handle-disconnect.js";

export class ConnectHost {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      connections: ConnectionRegistry;
      pending: PendingDisconnects;
      rooms: RoomRegistry;
    },
  ) {}

  async execute(input: {
    connection: Connection;
    room: Room;
    hostId: string;
    displayName: string;
  }): Promise<void> {
    const key = JSON.stringify([input.room.roomId, input.hostId]);
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.connect(input));
    this.pending.set(key, current);
    try {
      await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }

  private async connect(input: {
    connection: Connection;
    room: Room;
    hostId: string;
    displayName: string;
  }): Promise<void> {
    const { connection, room, hostId, displayName } = input;
    const existing = this.deps.connections.byClientId(room.roomId, hostId, "host");
    await this.deps.rooms.change(room, (draft) => draft.beginHostRecovery(hostId, displayName));
    this.deps.pending.cancel(room.roomId, "host", hostId);
    if (existing) {
      this.deps.connections.unregister(existing.connection.connectionId);
      existing.connection.close();
    }
    const host = room.snapshot().hosts.find((candidate) => candidate.hostId === hostId);
    if (!host) throw new Error(`방금 연결한 host가 snapshot에 없다: ${hostId}`);
    this.deps.connections.register({
      connection,
      roomId: room.roomId,
      clientId: hostId,
      hostId,
      role: "host",
    });
    connection.send({ type: "welcome", selfClientId: hostId, snapshot: room.snapshot() });
  }
}

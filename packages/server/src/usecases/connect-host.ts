import type { Room } from "../domain/room.js";
import type { RoomRegistry } from "../domain/room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { PendingDisconnects } from "./handle-disconnect.js";

export class ConnectHost {
  constructor(
    private readonly deps: {
      connections: ConnectionRegistry;
      pending: PendingDisconnects;
      rooms: RoomRegistry;
    },
  ) {}

  execute(input: {
    connection: Connection;
    room: Room;
    hostId: string;
    displayName: string;
  }): void {
    const { connection, room, hostId, displayName } = input;
    this.deps.pending.cancel(room.roomId, "host", hostId);
    const existing = this.deps.connections.byClientId(room.roomId, hostId, "host");
    if (existing) {
      this.deps.connections.unregister(existing.connection.connectionId);
      existing.connection.close();
    }

    room.beginHostRecovery(hostId, displayName);
    this.deps.rooms.save(room);
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

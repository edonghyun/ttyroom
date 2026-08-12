import type { Room } from "../domain/room.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry } from "./connection-registry.js";

export class ConnectHost {
  constructor(private readonly deps: { connections: ConnectionRegistry }) {}

  execute(input: {
    connection: Connection;
    room: Room;
    hostId: string;
    displayName: string;
  }): void {
    const { connection, room, hostId, displayName } = input;
    const existing = this.deps.connections.byClientId(room.roomId, hostId);
    if (existing) {
      this.deps.connections.unregister(existing.connection.connectionId);
      existing.connection.close();
    }

    room.connectHost(hostId, displayName);
    this.deps.connections.register({
      connection,
      roomId: room.roomId,
      clientId: hostId,
      hostId,
      role: "host",
    });
    connection.send({ type: "welcome", selfClientId: hostId, snapshot: room.snapshot() });
    this.deps.connections.broadcast(room.roomId, {
      type: "room-event",
      event: {
        kind: "host-connected",
        host: { hostId, name: displayName, online: true },
      },
    });
  }
}

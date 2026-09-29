import type { InputFrame } from "@ttyroom/protocol";
import type { RoomRegistry } from "./room-registry.js";
import type { Connection } from "../ports/transport.js";
import type { ConnectionRegistry, ParticipantSession } from "./connection-registry.js";
import type { OperationalDiagnostics } from "./operational-diagnostics.js";

export class RouteTerminalInput {
  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      diagnostics: OperationalDiagnostics;
    },
  ) {}

  execute(connection: Connection, session: ParticipantSession, frame: InputFrame): void {
    this.deps.diagnostics.terminalInput(
      {
        connectionId: connection.connectionId,
        roomId: session.roomId,
        terminalId: frame.terminalId,
        payloadBytes: frame.payload.byteLength,
      },
      () => {
        const room = this.deps.rooms.get(session.roomId);
        if (!room) throw new Error(`등록된 세션의 Room이 없다: ${session.roomId}`);

        const terminal = room.terminal(frame.terminalId);
        const host = terminal
          ? this.deps.connections.hostSession(room.roomId, terminal.hostId)
          : undefined;
        if (!terminal || terminal.status !== "open" || !host) {
          connection.send({
            type: "lease-invalid",
            terminalId: frame.terminalId,
            reason: "terminal-closed",
          });
          return { outcome: "rejected", reason: "terminal-closed" };
        }

        if (!room.isHostRemoteInputAllowed(terminal.hostId)) {
          connection.send({
            type: "lease-invalid",
            terminalId: frame.terminalId,
            reason: "remote-input-disabled",
          });
          return { outcome: "rejected", reason: "remote-input-disabled" };
        }

        if (!room.isInputAllowed(session.clientId, frame.terminalId, frame.leaseId)) {
          connection.send({
            type: "lease-invalid",
            terminalId: frame.terminalId,
            reason: "not-holder",
          });
          return { outcome: "rejected", reason: "not-holder" };
        }

        host.connection.sendData(frame);
        return { outcome: "forwarded" };
      },
    );
  }
}

import { decodeDataFrame } from "@ttyroom/protocol";
import type { Clock } from "../ports/clock.js";
import type { Identity } from "../ports/identity.js";
import type { Policy } from "../ports/policy.js";
import type { Connection } from "../ports/transport.js";
import { BroadcastTerminalOutput } from "./broadcast-terminal-output.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { ControlPlane } from "./control-plane.js";
import { HandleDisconnect, PendingDisconnects, type DisconnectTask } from "./handle-disconnect.js";
import { RoomEventPublisher } from "./room-event-publisher.js";
import { RoomRegistry } from "./room-registry.js";
import { RouteTerminalInput } from "./route-terminal-input.js";
import type { OperationalDiagnostics } from "./operational-diagnostics.js";

// Transport가 아는 유일한 application facade. Control message와 binary data의 서로 다른
// 처리 의미는 내부의 ControlPlane과 data relay로 분리한다.
export class ServerCore {
  private readonly pendingDisconnects: PendingDisconnects;
  private readonly controlPlane: ControlPlane;
  private readonly routeTerminalInput: RouteTerminalInput;
  private readonly broadcastTerminalOutput: BroadcastTerminalOutput;
  private readonly handleDisconnect: HandleDisconnect;

  constructor(
    private readonly deps: {
      rooms: RoomRegistry;
      connections: ConnectionRegistry;
      identity: Identity;
      clock: Clock;
      diagnostics: OperationalDiagnostics;
    },
    options: {
      policy: Policy;
      onBackgroundError?: (error: unknown, task: DisconnectTask) => void;
    },
  ) {
    this.pendingDisconnects = new PendingDisconnects(deps.clock, options.onBackgroundError);
    this.broadcastTerminalOutput = new BroadcastTerminalOutput(
      { rooms: deps.rooms, connections: deps.connections, diagnostics: deps.diagnostics },
      { policy: options.policy },
    );
    const events = new RoomEventPublisher(deps.connections);
    this.controlPlane = new ControlPlane({
      rooms: deps.rooms,
      connections: deps.connections,
      identity: deps.identity,
      pendingDisconnects: this.pendingDisconnects,
      output: this.broadcastTerminalOutput,
      events,
      diagnostics: deps.diagnostics,
    });
    this.routeTerminalInput = new RouteTerminalInput({
      rooms: deps.rooms,
      connections: deps.connections,
      diagnostics: deps.diagnostics,
    });
    this.handleDisconnect = new HandleDisconnect(
      {
        rooms: deps.rooms,
        connections: deps.connections,
        events,
        pending: this.pendingDisconnects,
      },
      { policy: options.policy },
    );
  }

  handleMessage(connection: Connection, raw: string): Promise<void> {
    return this.controlPlane.handle(connection, raw);
  }

  handleData(connection: Connection, bytes: Uint8Array): void {
    const decoded = decodeDataFrame(bytes);
    if (decoded.kind === "malformed") {
      connection.send({ type: "error", code: "bad-message", message: decoded.reason });
      return;
    }

    const session = this.deps.connections.bySessionOf(connection.connectionId);
    if (session?.role === "host" && decoded.frame.kind === "output") {
      this.broadcastTerminalOutput.execute(connection, session, decoded.frame);
      return;
    }

    if (!session || session.role !== "participant" || decoded.frame.kind !== "input") {
      connection.send({
        type: "error",
        code: "bad-message",
        message: "허용되지 않은 데이터 프레임",
      });
      return;
    }

    this.routeTerminalInput.execute(connection, session, decoded.frame);
  }

  async handleClose(connection: Connection): Promise<void> {
    await this.handleDisconnect.execute(connection);
  }

  async close(): Promise<void> {
    await this.pendingDisconnects.close();
  }

  backgroundTaskCount(): number {
    return this.pendingDisconnects.activeCount();
  }
}

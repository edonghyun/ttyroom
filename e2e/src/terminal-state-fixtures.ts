import type { SocketProbe } from "@ttyroom/test-support/socket-probe";

type WorkspacePeers = { host: SocketProbe; observer: SocketProbe };

const missingTerminal = {
  name: "missing",
  terminalId: 99,
  reason: "terminal-not-found",
  async prepare(_fixture: WorkspacePeers) {},
} as const;
const exitedTerminal = {
  name: "exited",
  terminalId: 7,
  reason: "terminal-not-open",
  async prepare({ host, observer }: WorkspacePeers) {
    host.send({ type: "terminal-closed", terminalId: 7, exitCode: 0 });
    const closed = await observer.next();
    if (closed.type !== "room-event" || closed.event.kind !== "terminal-closed")
      throw new Error("Expected terminal exit during preparation");
  },
} as const;
const offlineTerminal = {
  name: "offline",
  terminalId: 7,
  reason: "host-offline",
  async prepare({ host, observer }: WorkspacePeers) {
    await host.disconnect();
    const offline = await observer.next();
    if (offline.type !== "room-event" || offline.event.kind !== "host-offline")
      throw new Error("Expected host disconnect during preparation");
  },
} as const;

// Same rejection contracts, different explicit preparations. Tests retain all expectations.
export const closedTerminalStates = [missingTerminal, exitedTerminal] as const;
export const unavailableTerminalStates = [...closedTerminalStates, offlineTerminal] as const;

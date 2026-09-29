import { encodeDataFrame } from "@ttyroom/protocol";
import { protocolWorkspaceFixture } from "./protocol-fixture.js";
import type { SocketProbe } from "./socket-probe.js";

export async function acquire(peer: SocketProbe, terminalId = 7) {
  peer.send({ type: "acquire-lease", terminalId });
  return peer.next();
}
export async function inputFixture() {
  const fixture = await protocolWorkspaceFixture([7, 8]);
  try {
    fixture.host.send({ type: "host-input-state", remoteInputAllowed: true });
    const permission = await fixture.observer.next();
    if (
      permission.type !== "room-event" ||
      permission.event.kind !== "host-input-state-changed" ||
      !permission.event.remoteInputAllowed
    )
      throw new Error("Input fixture requires host permission");
    const acquired = await acquire(fixture.observer);
    if (acquired.type !== "lease-result" || acquired.result.kind !== "granted")
      throw new Error("Input fixture requires an exclusive lease");
    const granted = await fixture.observer.next();
    if (
      granted.type !== "room-event" ||
      granted.event.kind !== "lease-granted" ||
      granted.event.lease.leaseId !== acquired.result.leaseId
    )
      throw new Error("Expected lease publication before input actions");
    return {
      ...fixture,
      leaseId: acquired.result.leaseId,
      async joinParticipant(clientId: string) {
        const joined = await fixture.join(clientId, "participant");
        for (const terminal of joined.welcome.snapshot.terminals) {
          if (terminal.status !== "open") continue;
          const sync = await joined.peer.next();
          if (sync.type !== "sync" || sync.terminalId !== terminal.terminalId || sync.seq !== 0)
            throw new Error("Expected empty-history sync before participant actions");
        }
        return joined;
      },
    };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}
export function sendInput(peer: SocketProbe, leaseId: number, terminalId = 7, seq = 17) {
  const frame = {
    kind: "input" as const,
    terminalId,
    seq,
    leaseId,
    payload: Buffer.from([0, 255, 13, 10]),
  };
  peer.sendBytes(encodeDataFrame(frame));
  return { kind: "binary", frame };
}

export async function sharedInputFixture() {
  const fixture = await inputFixture();
  try {
    fixture.observer.send({ type: "set-terminal-mode", terminalId: 7, mode: "shared" });
    const result = await fixture.observer.next();
    if (result.type !== "room-event" || result.event.kind !== "terminal-mode-changed")
      throw new Error(`Shared fixture requires mode change: ${JSON.stringify(result)}`);
    return fixture;
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

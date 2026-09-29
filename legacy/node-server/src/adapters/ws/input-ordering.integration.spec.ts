import { once } from "node:events";
import { createServer } from "node:http";
import {
  encodeDataFrame,
  parseServerMessage,
  LEGACY_PROTOCOL_VERSION,
  serializeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@ttyroom/protocol";
import WebSocket from "ws";
import { expect, it } from "vitest";
import {
  RecordingRoomRepository,
  type DeferredRepositoryCall,
} from "../../test/recording-room-repository.js";
import { RoomTestContext } from "../../test/room-test-context.js";
import { WsTransport } from "./ws-transport.js";

it("저장 뒤 대기 중인 lease 반납이 같은 연결의 후속 binary보다 먼저 적용된다", async () => {
  await using fixture = await inputEnabledRoom();
  const saving = fixture.holdNextSave();

  fixture.renameTerminal("Saved");
  await within(saving.started);
  fixture.releaseLease();
  fixture.sendInput(1);
  await fixture.awaitReceiveBarrier();
  const forwardedWhileSaving = [...fixture.host.conn.dataFrames];
  saving.release();
  await fixture.awaitLeaseReleased();
  const rejected = await fixture.awaitNotice("lease-invalid");

  expect(forwardedWhileSaving).toEqual([]);
  expect(rejected).toEqual({ type: "lease-invalid", terminalId: 7, reason: "not-holder" });
  expect(fixture.host.conn.dataFrames).toEqual([]);
});

/** Real transport and core; repository delays storage and the host records forwarded input. */
async function inputEnabledRoom() {
  const repository = new RecordingRoomRepository();
  const ctx = new RoomTestContext({ repository });
  const server = createServer();
  const transport = new WsTransport({ core: ctx.core }, { server });
  let socket: WebSocket | undefined;
  let saving: DeferredRepositoryCall | undefined;

  async function close(): Promise<void> {
    saving?.release();
    socket?.terminate();
    try {
      await transport.close();
    } finally {
      try {
        await ctx.close();
      } finally {
        if (server.listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }
    }
  }

  try {
    const room = await ctx.createRoom();
    const host = await ctx.connectHost(room, "Host");
    host.allowConnectorData();
    await host.send({
      type: "host-inventory",
      terminals: [{ terminalId: 7, runtimeId: "runtime-7", firstRetainedSeq: 0, lastOutputSeq: 0 }],
    });
    await host.send({ type: "host-input-state", remoteInputAllowed: true });
    const listening = once(server, "listening", { signal: AbortSignal.timeout(3000) });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture HTTP port is missing");
    const alice = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    socket = alice;
    const notices: ServerMessage[] = [];
    alice.on("message", (raw, binary) => {
      if (binary) throw new Error("Unexpected output in input ordering fixture");
      const parsed = parseServerMessage(raw.toString());
      if (parsed.kind === "bad-message") throw new Error(parsed.reason);
      notices.push(parsed.message);
    });
    await once(alice, "open", { signal: AbortSignal.timeout(3000) });

    function send(command: ClientMessage): void {
      alice.send(serializeClientMessage(command));
    }

    async function awaitMatching(predicate: (notice: ServerMessage) => boolean) {
      const signal = AbortSignal.timeout(3000);
      while (true) {
        const found = notices.find(predicate);
        if (found) return found;
        await once(alice, "message", { signal });
      }
    }

    async function awaitNotice(type: ServerMessage["type"]) {
      return awaitMatching((notice) => notice.type === type);
    }

    send({
      type: "hello",
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      ...room,
      clientId: "alice",
      name: "Alice",
      role: "participant",
    });
    await awaitNotice("welcome");
    send({ type: "acquire-lease", terminalId: 7 });
    const grant = await awaitNotice("lease-result");
    if (grant.type !== "lease-result" || grant.result.kind !== "granted") {
      throw new Error("Fixture lease was not granted");
    }
    const leaseId = grant.result.leaseId;

    return {
      host,
      holdNextSave() {
        saving = repository.deferNextSave();
        return saving;
      },
      renameTerminal(title: string) {
        send({ type: "rename-terminal", terminalId: 7, title });
      },
      releaseLease() {
        send({ type: "release-lease", terminalId: 7, leaseId });
      },
      sendInput(seq: number) {
        alice.send(
          encodeDataFrame({
            kind: "input",
            terminalId: 7,
            seq,
            leaseId,
            payload: new Uint8Array([65]),
          }),
        );
      },
      async awaitReceiveBarrier() {
        // The pong follows receipt of preceding frames, even while application processing waits.
        const pong = once(alice, "pong", { signal: AbortSignal.timeout(3000) });
        alice.ping();
        await pong;
      },
      awaitLeaseReleased: () =>
        awaitMatching(
          (notice) => notice.type === "room-event" && notice.event.kind === "lease-released",
        ),
      awaitNotice,
      [Symbol.asyncDispose]: close,
    };
  } catch (failure) {
    await close();
    throw failure;
  }
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Storage did not reach its gate")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

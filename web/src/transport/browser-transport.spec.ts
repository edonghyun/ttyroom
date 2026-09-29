import { decodeDataFrame, encodeDataFrame, PROTOCOL_VERSION } from "@ttyroom/protocol";
import { describe, expect, it, vi } from "vitest";

import { FakeBrowserSocket } from "../test/fake-browser-socket.js";
import { BrowserTransport } from "./browser-transport.js";

describe("BrowserTransport — browser protocol boundary", () => {
  it("connects to same-origin /ws and sends hello exactly once after open", () => {
    const socket = new FakeBrowserSocket();
    let socketUrl = "";
    const transport = new BrowserTransport(
      {
        socketFactory: {
          create: (url) => {
            socketUrl = url;
            return socket;
          },
        },
        locationHref: "https://ttyroom.test/r/room-1#secret-token",
      },
      {
        hello: {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          roomId: "room-1",
          credential: "p".repeat(32),
          name: "Alice",
        },
      },
    );

    transport.start();
    socket.open();
    socket.open();

    expect(socketUrl).toBe("wss://ttyroom.test/ws");
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        roomId: "room-1",
        credential: "p".repeat(32),
        name: "Alice",
      }),
    ]);
  });

  it("parses JSON server messages through the public protocol", () => {
    const { socket, subscriber } = startedTransport();

    socket.message(
      JSON.stringify({
        type: "error",
        code: "room-not-found",
        message: "Room is gone",
      }),
    );

    expect(subscriber).toHaveBeenCalledWith({
      kind: "server-message",
      message: { type: "error", code: "room-not-found", message: "Room is gone" },
    });
  });

  it("decodes binary output frames into protocol output events", () => {
    const { socket, subscriber } = startedTransport();
    const encoded = encodeDataFrame({
      kind: "output",
      terminalId: 3,
      seq: 9,
      payload: new Uint8Array([65, 66]),
    });

    socket.message(encoded.buffer);

    expect(subscriber).toHaveBeenCalledWith({
      kind: "output",
      frame: {
        kind: "output",
        terminalId: 3,
        seq: 9,
        payload: new Uint8Array([65, 66]),
      },
    });
  });

  it("reports malformed control and data frames as typed failures", () => {
    const { socket, subscriber } = startedTransport();

    socket.message('{"type":"welcome","token":"secret-token"}');
    socket.message(new Uint8Array([1, 2]).buffer);

    expect(subscriber.mock.calls.map((call) => call[0])).toEqual([
      { kind: "failure", reason: "malformed-control" },
      { kind: "failure", reason: "malformed-data" },
    ]);
    expect(JSON.stringify(subscriber.mock.calls)).not.toContain("secret-token");
  });

  it("disposes once and ignores every late socket event", () => {
    const { socket, subscriber, transport } = startedTransport();

    transport.dispose();
    transport.dispose();
    socket.open();
    socket.message(JSON.stringify({ type: "error", code: "room-not-found", message: "gone" }));
    socket.closed();
    socket.failed();

    expect(socket.closeCount).toBe(1);
    expect(socket.sent).toEqual([]);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("reports socket close and error without exposing connection details", () => {
    const { socket, subscriber } = startedTransport();

    socket.closed();
    socket.failed();

    expect(subscriber.mock.calls.map((call) => call[0])).toEqual([
      { kind: "closed" },
      { kind: "failure", reason: "socket-error" },
    ]);
  });

  it("serializes public control and input frames only after the socket opens", () => {
    const socket = new FakeBrowserSocket();
    const transport = createTransport(socket);
    transport.start();

    transport.sendControl({ type: "close-terminal-request", terminalId: 3 });
    socket.open();
    transport.sendControl({ type: "close-terminal-request", terminalId: 3 });
    transport.sendInput({
      kind: "input",
      terminalId: 3,
      seq: 1,
      leaseId: 7,
      payload: new Uint8Array([65]),
    });

    expect(socket.sent[1]).toBe(JSON.stringify({ type: "close-terminal-request", terminalId: 3 }));
    const data = socket.sent[2];
    if (!(data instanceof ArrayBuffer)) throw new Error("Expected binary input frame");
    expect(decodeDataFrame(new Uint8Array(data))).toEqual({
      kind: "ok",
      frame: {
        kind: "input",
        terminalId: 3,
        seq: 1,
        leaseId: 7,
        payload: new Uint8Array([65]),
      },
    });
    expect(socket.sent).toHaveLength(3);
  });
});

function createTransport(socket: FakeBrowserSocket): BrowserTransport {
  return new BrowserTransport(
    {
      socketFactory: {
        create: (url) => {
          void url;
          return socket;
        },
      },
      locationHref: "https://ttyroom.test/r/room-1#secret-token",
    },
    {
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        roomId: "room-1",
        credential: "p".repeat(32),
        name: "Alice",
      },
    },
  );
}

function startedTransport(): {
  socket: FakeBrowserSocket;
  transport: BrowserTransport;
  subscriber: ReturnType<typeof vi.fn>;
} {
  const socket = new FakeBrowserSocket();
  const transport = createTransport(socket);
  const subscriber = vi.fn();
  transport.subscribe(subscriber);
  transport.start();
  return { socket, transport, subscriber };
}

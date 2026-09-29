import { describe, expect, it } from "vitest";
import { RecordingConnection } from "../test/recording-connection.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { RoomEventPublisher } from "./room-event-publisher.js";

describe("RoomEventPublisher — 역할: Room change를 protocol event로 발행", () => {
  it("domain terminal을 wire view로 복사해 Room participant에게 방송한다", () => {
    const connections = new ConnectionRegistry();
    const connection = new RecordingConnection({ connectionId: "conn-1" });
    connections.register({
      connection,
      roomId: "r1",
      clientId: "p1",
      role: "participant",
    });
    const publisher = new RoomEventPublisher(connections);
    const terminal = {
      terminalId: 1,
      hostId: "h1",
      title: "shell",
      geometry: { x: 10, y: 20, width: 800, height: 600 },
      mode: "exclusive" as const,
      status: "open" as const,
      exitCode: null,
      meta: { cwd: "/repo", gitBranch: "main", fgProcess: "vim" },
    };

    publisher.publish("r1", { kind: "terminal-opened", terminal });

    expect(connection.messages).toEqual([
      { type: "room-event", event: { kind: "terminal-opened", terminal } },
    ]);
    const published = connection.messages[0];
    if (published?.type !== "room-event" || published.event.kind !== "terminal-opened") {
      throw new Error("terminal-opened가 발행되지 않았다");
    }
    expect(published.event.terminal).not.toBe(terminal);
    expect(published.event.terminal.geometry).not.toBe(terminal.geometry);
    expect(published.event.terminal.meta).not.toBe(terminal.meta);
  });
});

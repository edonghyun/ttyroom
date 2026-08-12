import {
  encodeDataFrame,
  PROTOCOL_VERSION,
  serializeClientMessage,
  type ClientMessage,
} from "@ttyroom/protocol";
import { LinkAuth } from "../adapters/link-auth/link-auth.js";
import { NoopSnapshotStore } from "../adapters/memory/noop-snapshot-store.js";
import { RoomRegistry } from "../domain/room-registry.js";
import { DEFAULT_POLICY, type Policy } from "../ports/policy.js";
import { ConnectionRegistry } from "../usecases/connection-registry.js";
import { ServerCore } from "../usecases/server-core.js";
import { FakeClock } from "./fake-clock.js";
import { RecordingConnection } from "./recording-connection.js";

export interface ParticipantHandle {
  clientId: string;
  conn: RecordingConnection;
  send(msg: ClientMessage): void;
  sendInput(terminalId: number, leaseId: number, text: string, seq?: number): void;
  disconnect(): void;
}

export interface HostHandle {
  hostId: string;
  clientId: string;
  conn: RecordingConnection;
  send(msg: ClientMessage): void;
  sendOutput(terminalId: number, seq: number, text: string): void;
  allowAgentData(): void;
  disconnect(): void;
}

// 테스트 컴포지션 루트 — 실제 부팅(main.ts)과 같은 배선을 FakeClock·기록 연결로 재현한다
export class RoomTestContext {
  readonly clock = new FakeClock();
  readonly core: ServerCore;

  private readonly rooms = new RoomRegistry();
  private readonly connections = new ConnectionRegistry();
  private nextRoomNumber = 1;
  private nextConnectionNumber = 1;
  private nextClientNumber = 1;
  private nextHostNumber = 1;

  constructor(options?: { policy?: Partial<Policy> }) {
    this.core = new ServerCore(
      {
        rooms: this.rooms,
        connections: this.connections,
        identity: new LinkAuth(),
        clock: this.clock,
        snapshots: new NoopSnapshotStore(),
      },
      { policy: { ...DEFAULT_POLICY, ...options?.policy } },
    );
  }

  createRoom(roomId?: string): { roomId: string; token: string } {
    const n = this.nextRoomNumber;
    this.nextRoomNumber += 1;

    const id = roomId ?? `room-${n}`;
    const token = `tok-${n}`;
    this.rooms.create({ roomId: id, token });
    return { roomId: id, token };
  }

  rawConnection(): RecordingConnection {
    const n = this.nextConnectionNumber;
    this.nextConnectionNumber += 1;
    return new RecordingConnection({ connectionId: `conn-${n}` });
  }

  connectParticipant(
    room: { roomId: string; token: string },
    name: string,
    clientId?: string,
  ): ParticipantHandle {
    const conn = this.rawConnection();
    const id = clientId ?? `c-${this.nextClientNumber}`;
    this.nextClientNumber += 1;

    const send = (msg: ClientMessage): void => {
      this.core.handleMessage(conn, serializeClientMessage(msg));
    };
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      roomId: room.roomId,
      token: room.token,
      clientId: id,
      name,
      role: "participant",
    });

    return {
      clientId: id,
      conn,
      send,
      sendInput: (terminalId, leaseId, text, seq = 1) => {
        this.core.handleData(
          conn,
          encodeDataFrame({
            kind: "input",
            terminalId,
            seq,
            leaseId,
            payload: new TextEncoder().encode(text),
          }),
        );
      },
      disconnect: () => this.core.handleClose(conn),
    };
  }

  connectHost(room: { roomId: string; token: string }, name: string, hostId?: string): HostHandle {
    const n = this.nextConnectionNumber;
    this.nextConnectionNumber += 1;

    // 스펙 요구 — 테스트가 명시적으로 허용하지 않은 서버→Agent 입력 전달은 즉시 실패
    let agentDataAllowed = false;
    const conn = new RecordingConnection({
      connectionId: `conn-${n}`,
      guard: (what) => {
        if (what === "data" && !agentDataAllowed) {
          throw new Error(
            "Unexpected agent write to host connection — " +
              "call host.allowAgentData() in tests that expect input forwarding",
          );
        }
      },
    });

    const id = hostId ?? `h-${this.nextHostNumber}`;
    this.nextHostNumber += 1;
    const clientId = `hc-${id}`;

    const send = (msg: ClientMessage): void => {
      this.core.handleMessage(conn, serializeClientMessage(msg));
    };
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      roomId: room.roomId,
      token: room.token,
      clientId,
      name,
      role: "host",
    });

    return {
      hostId: id,
      clientId,
      conn,
      send,
      sendOutput: (terminalId, seq, text) => {
        this.core.handleData(
          conn,
          encodeDataFrame({
            kind: "output",
            terminalId,
            seq,
            payload: new TextEncoder().encode(text),
          }),
        );
      },
      allowAgentData: () => {
        agentDataAllowed = true;
      },
      disconnect: () => this.core.handleClose(conn),
    };
  }
}

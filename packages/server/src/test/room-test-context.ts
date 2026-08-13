import {
  encodeDataFrame,
  PROTOCOL_VERSION,
  serializeClientMessage,
  type ClientMessage,
  type RoomSnapshot,
} from "@ttyroom/protocol";
import { LinkAuth } from "../adapters/link-auth/link-auth.js";
import { RoomRegistry } from "../domain/room-registry.js";
import { DEFAULT_POLICY, type Policy } from "../ports/policy.js";
import type { RoomRepository } from "../ports/room-repository.js";
import { ConnectionRegistry } from "../usecases/connection-registry.js";
import { ServerCore } from "../usecases/server-core.js";
import { FakeClock } from "./fake-clock.js";
import { RecordingConnection } from "./recording-connection.js";

export interface ParticipantHandle {
  clientId: string;
  conn: RecordingConnection;
  send(msg: ClientMessage): Promise<void>;
  sendInput(terminalId: number, leaseId: number, text: string, seq?: number): void;
  disconnect(): Promise<void>;
}

export interface HostHandle {
  hostId: string;
  clientId: string;
  conn: RecordingConnection;
  send(msg: HostTestMessage): Promise<void>;
  sendOutput(terminalId: number, seq: number, text: string): void;
  allowAgentData(): void;
  disconnect(): Promise<void>;
}

export interface TestRoom {
  roomId: string;
  token: string;
}

type HostTestMessage =
  ClientMessage | { type: "terminal-opened"; terminalId: number; runtimeId?: string };

export class RoomTestContext {
  readonly clock = new FakeClock();
  readonly core: ServerCore;

  private readonly rooms: RoomRegistry;
  private readonly connections = new ConnectionRegistry();
  private nextRoomNumber = 1;
  private nextConnectionNumber = 1;
  private nextClientNumber = 1;
  private nextHostNumber = 1;

  constructor(options?: {
    policy?: Partial<Policy>;
    repository?: RoomRepository;
    onBackgroundError?: ConstructorParameters<typeof ServerCore>[1]["onBackgroundError"];
  }) {
    this.rooms = new RoomRegistry(options?.repository ?? null);
    this.core = new ServerCore(
      {
        rooms: this.rooms,
        connections: this.connections,
        identity: new LinkAuth(),
        clock: this.clock,
      },
      {
        policy: { ...DEFAULT_POLICY, ...options?.policy },
        onBackgroundError: options?.onBackgroundError,
      },
    );
  }

  async createRoom(roomId?: string): Promise<TestRoom> {
    const n = this.nextRoomNumber;
    this.nextRoomNumber += 1;

    const id = roomId ?? `room-${n}`;
    const token = `tok-${n}`;
    await this.rooms.create({ roomId: id, token });
    return { roomId: id, token };
  }

  rawConnection(): RecordingConnection {
    const n = this.nextConnectionNumber;
    this.nextConnectionNumber += 1;
    return new RecordingConnection({ connectionId: `conn-${n}` });
  }

  async setTerminalMode(
    room: { roomId: string },
    terminalId: number,
    mode: "exclusive" | "shared",
  ): Promise<void> {
    const aggregate = this.rooms.get(room.roomId);
    if (!aggregate) throw new Error(`테스트 Room이 없다: ${room.roomId}`);
    await this.rooms.change(aggregate, (draft) => draft.setTerminalMode(terminalId, mode));
  }

  snapshot(room: { roomId: string }): RoomSnapshot | undefined {
    return this.rooms.get(room.roomId)?.snapshot();
  }

  close(): Promise<void> {
    return this.core.close();
  }

  async connectParticipant(
    room: TestRoom,
    name: string,
    clientId?: string,
  ): Promise<ParticipantHandle> {
    const conn = this.rawConnection();
    const id = clientId ?? `c-${this.nextClientNumber}`;
    this.nextClientNumber += 1;

    const send = (msg: ClientMessage): Promise<void> =>
      this.core.handleMessage(conn, serializeClientMessage(msg));
    await send({
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

  async connectHost(room: TestRoom, name: string, hostId?: string): Promise<HostHandle> {
    const n = this.nextConnectionNumber;
    this.nextConnectionNumber += 1;

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
    const clientId = id;
    const aggregate = this.rooms.get(room.roomId);
    const existingInventory =
      aggregate
        ?.snapshot()
        .terminals.filter((terminal) => terminal.hostId === id && terminal.status === "open")
        .map((terminal) => ({
          terminalId: terminal.terminalId,
          runtimeId:
            aggregate.terminalRuntimeId(terminal.terminalId) ?? `runtime-${terminal.terminalId}`,
          firstRetainedSeq: 0,
          lastOutputSeq: 0,
        })) ?? [];

    const send = (msg: HostTestMessage): Promise<void> => {
      const normalized: ClientMessage =
        msg.type === "terminal-opened"
          ? {
              ...msg,
              runtimeId: msg.runtimeId ?? `runtime-${msg.terminalId}`,
            }
          : msg;
      return this.core.handleMessage(conn, serializeClientMessage(normalized));
    };
    await send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      roomId: room.roomId,
      token: room.token,
      clientId,
      name,
      role: "host",
    });
    await send({ type: "host-inventory", terminals: existingInventory });
    await send({ type: "host-input-state", remoteInputAllowed: true });

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

  async openTerminal(
    participant: ParticipantHandle,
    host: HostHandle,
    runtimeId?: string,
  ): Promise<number> {
    await participant.send({ type: "open-terminal-request", hostId: host.hostId });
    const { terminalId } = host.conn.lastMessageOfType("open-terminal");
    await host.send({ type: "terminal-opened", terminalId, runtimeId });
    return terminalId;
  }

  async acquireLease(participant: ParticipantHandle, terminalId: number): Promise<number> {
    await participant.send({ type: "acquire-lease", terminalId });
    const { result } = participant.conn.lastMessageOfType("lease-result");
    if (result.kind !== "granted") {
      throw new Error(`입력권을 얻지 못했다: ${JSON.stringify(result)}`);
    }
    return result.leaseId;
  }
}

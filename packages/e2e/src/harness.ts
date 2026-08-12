import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  decodeDataFrame,
  encodeDataFrame,
  parseServerMessage,
  serializeClientMessage,
  type LeaseResult,
  type RoomEvent,
  type RoomSnapshot,
  type ServerMessage,
} from "@ttyroom/protocol";
import { loadConfig, startServer, type ServerConfig } from "@ttyroom/server";
import WebSocket, { type RawData } from "ws";

type Policy = ServerConfig["policy"];

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

export interface TestRoom {
  roomId: string;
  token: string;
  joinUrl: string;
  baseUrl: string;
}

export interface AgentHandle {
  hostId: string;
  kill(signal?: NodeJS.Signals): void;
}

export interface ParticipantClient {
  clientId: string;
  snapshot(): RoomSnapshot;
  openTerminal(hostId: string): Promise<number>;
  acquire(terminalId: number): Promise<LeaseResult>;
  type(terminalId: number, text: string): void;
  outputText(terminalId: number): string;
  syncedSeq(terminalId: number): number;
  lastMessages(): ServerMessage[];
  close(): void;
}

export interface TestServer {
  room(): Promise<TestRoom>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Given {
  server(policy?: Partial<Policy>): Promise<TestServer>;
  agent(room: TestRoom, name?: string): Promise<AgentHandle>;
  participant(room: TestRoom, name: string, clientId?: string): Promise<ParticipantClient>;
}

class E2eServer implements TestServer {
  private readonly children = new Set<ChildProcess>();
  private readonly participants = new Set<WsParticipant>();
  private closed = false;

  constructor(private readonly running: Awaited<ReturnType<typeof startServer>>) {}

  async room(): Promise<TestRoom> {
    const response = await fetch(`${this.running.httpBaseUrl}/api/rooms`, { method: "POST" });
    if (response.status !== 201) {
      throw new Error(`Room 생성 실패: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { roomId: string; token: string; joinUrl: string };
    return { ...body, baseUrl: this.running.httpBaseUrl };
  }

  async agent(room: TestRoom, name = "host"): Promise<AgentHandle> {
    const observer = await this.participant(room, `observer-${name}`);
    const before = observer.lastMessages().length;
    const child = spawn(
      process.execPath,
      ["--import", TSX_LOADER, "packages/agent/src/index.ts", "join", room.joinUrl, "--name", name],
      { cwd: WORKSPACE_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.children.add(child);
    const diagnostics: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString("utf8")));
    child.once("exit", () => this.children.delete(child));

    const connected = await observer.waitForMessage(
      (message) => message.type === "room-event" && message.event.kind === "host-connected",
      before,
      () => `Agent가 연결 전에 종료됨${formatDiagnostics(diagnostics)}`,
      child,
    );
    if (connected.type !== "room-event" || connected.event.kind !== "host-connected") {
      throw new Error("host-connected 대기 결과가 계약과 다르다");
    }

    return {
      hostId: connected.event.host.hostId,
      kill: (signal = "SIGTERM") => child.kill(signal),
    };
  }

  async participant(
    room: TestRoom,
    name: string,
    clientId: string = crypto.randomUUID(),
  ): Promise<WsParticipant> {
    const participant = await WsParticipant.connect(room, name, clientId);
    this.participants.add(participant);
    participant.onClosed(() => this.participants.delete(participant));
    return participant;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const participant of [...this.participants]) participant.close();
    await Promise.all([...this.children].map((child) => terminateChild(child)));
    await this.running.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

class WsParticipant implements ParticipantClient {
  private readonly messages: ServerMessage[] = [];
  private readonly output = new Map<number, Uint8Array[]>();
  private readonly syncs = new Map<number, number>();
  private readonly leases = new Map<number, number>();
  private readonly closedHandlers: Array<() => void> = [];
  private currentSnapshot: RoomSnapshot | undefined;
  private inputSeq = 0;

  private constructor(
    readonly clientId: string,
    private readonly websocket: WebSocket,
  ) {
    websocket.on("message", (raw, isBinary) => this.receive(raw, isBinary));
    websocket.once("close", () => {
      for (const handler of this.closedHandlers) handler();
    });
  }

  static async connect(room: TestRoom, name: string, clientId: string): Promise<WsParticipant> {
    const websocket = new WebSocket(room.baseUrl.replace(/^http/, "ws") + "/ws");
    await waitForWebSocketOpen(websocket);
    const participant = new WsParticipant(clientId, websocket);
    websocket.send(
      serializeClientMessage({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        roomId: room.roomId,
        token: room.token,
        clientId,
        name,
        role: "participant",
      }),
    );
    await participant.waitForMessage((message) => message.type === "welcome", 0);
    return participant;
  }

  snapshot(): RoomSnapshot {
    if (!this.currentSnapshot) throw new Error("welcome snapshot을 아직 받지 못했다");
    return structuredClone(this.currentSnapshot);
  }

  async openTerminal(hostId: string): Promise<number> {
    const before = this.messages.length;
    this.send({ type: "open-terminal-request", hostId });
    const opened = await this.waitForMessage(
      (message) => message.type === "room-event" && message.event.kind === "terminal-opened",
      before,
    );
    if (opened.type !== "room-event" || opened.event.kind !== "terminal-opened") {
      throw new Error("terminal-opened 대기 결과가 계약과 다르다");
    }
    return opened.event.terminal.terminalId;
  }

  async acquire(terminalId: number): Promise<LeaseResult> {
    const before = this.messages.length;
    this.send({ type: "acquire-lease", terminalId });
    const result = await this.waitForMessage(
      (message) => message.type === "lease-result" && message.terminalId === terminalId,
      before,
    );
    if (result.type !== "lease-result") throw new Error("lease-result 대기 결과가 계약과 다르다");
    if (result.result.kind === "granted") this.leases.set(terminalId, result.result.leaseId);
    return result.result;
  }

  type(terminalId: number, text: string): void {
    const leaseId = this.leases.get(terminalId);
    if (leaseId === undefined) throw new Error(`터미널 ${terminalId}의 임대가 없다`);
    this.inputSeq += 1;
    this.websocket.send(
      encodeDataFrame({
        kind: "input",
        terminalId,
        seq: this.inputSeq,
        leaseId,
        payload: new TextEncoder().encode(text),
      }),
    );
  }

  outputText(terminalId: number): string {
    const chunks = this.output.get(terminalId) ?? [];
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  }

  syncedSeq(terminalId: number): number {
    return this.syncs.get(terminalId) ?? 0;
  }

  lastMessages(): ServerMessage[] {
    return structuredClone(this.messages);
  }

  close(): void {
    if (this.websocket.readyState === WebSocket.OPEN) this.websocket.close();
  }

  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler);
  }

  async waitForMessage(
    predicate: (message: ServerMessage) => boolean,
    afterIndex: number,
    failure?: () => string,
    child?: ChildProcess,
  ): Promise<ServerMessage> {
    await waitUntil(
      () =>
        this.messages.slice(afterIndex).some(predicate) ||
        (child !== undefined && (child.exitCode !== null || child.signalCode !== null)),
      { failure },
    );
    const message = this.messages.slice(afterIndex).find(predicate);
    if (!message) throw new Error(failure?.() ?? "기대한 서버 메시지가 도착하지 않았다");
    return message;
  }

  private send(message: Parameters<typeof serializeClientMessage>[0]): void {
    this.websocket.send(serializeClientMessage(message));
  }

  private receive(raw: RawData, isBinary: boolean): void {
    if (isBinary) {
      const bytes =
        raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as Buffer);
      const decoded = decodeDataFrame(bytes);
      if (decoded.kind !== "ok" || decoded.frame.kind !== "output") return;
      const chunks = this.output.get(decoded.frame.terminalId) ?? [];
      chunks.push(decoded.frame.payload);
      this.output.set(decoded.frame.terminalId, chunks);
      return;
    }

    const parsed = parseServerMessage(raw.toString());
    if (parsed.kind !== "ok")
      throw new Error(`서버가 잘못된 제어 메시지를 보냈다: ${parsed.reason}`);
    const message = parsed.message;
    this.messages.push(message);
    if (message.type === "welcome") this.currentSnapshot = structuredClone(message.snapshot);
    if (message.type === "room-event" && this.currentSnapshot) {
      applyRoomEvent(this.currentSnapshot, message.event);
    }
    if (message.type === "sync") this.syncs.set(message.terminalId, message.seq);
  }
}

export const given: Given = {
  async server(policy = {}): Promise<E2eServer> {
    const config = loadConfig({ file: { port: 0, policy }, env: {} });
    const running = await startServer(config);
    const server = new E2eServer(running);
    activeServer = server;
    return server;
  },
  agent(room, name): Promise<AgentHandle> {
    return requireActiveServer().agent(room, name);
  },
  participant(room, name, clientId): Promise<ParticipantClient> {
    return requireActiveServer().participant(room, name, clientId);
  },
};

let activeServer: E2eServer | undefined;

function requireActiveServer(): E2eServer {
  if (!activeServer) throw new Error("given.server()를 먼저 호출해야 한다");
  return activeServer;
}

export async function waitUntil(
  condition: () => boolean,
  options: { timeoutMs?: number; failure?: () => string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(options.failure?.() ?? "조건 대기 시간이 초과됐다");
    }
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
}

function applyRoomEvent(snapshot: RoomSnapshot, event: RoomEvent): void {
  switch (event.kind) {
    case "participant-joined":
      upsert(
        snapshot.participants,
        (item) => item.clientId === event.participant.clientId,
        event.participant,
      );
      return;
    case "participant-left":
      remove(snapshot.participants, (item) => item.clientId === event.clientId);
      return;
    case "host-connected":
      upsert(snapshot.hosts, (item) => item.hostId === event.host.hostId, event.host);
      return;
    case "host-offline": {
      const host = snapshot.hosts.find((item) => item.hostId === event.hostId);
      if (host) host.online = false;
      return;
    }
    case "host-removed":
      remove(snapshot.hosts, (item) => item.hostId === event.hostId);
      return;
    case "terminal-opened":
      upsert(
        snapshot.terminals,
        (item) => item.terminalId === event.terminal.terminalId,
        event.terminal,
      );
      return;
    case "terminal-closed": {
      const terminal = snapshot.terminals.find((item) => item.terminalId === event.terminalId);
      if (terminal) {
        terminal.status = "exited";
        terminal.exitCode = event.exitCode;
      }
      return;
    }
    case "lease-granted":
      upsert(snapshot.leases, (item) => item.terminalId === event.lease.terminalId, event.lease);
      return;
    case "lease-released":
      remove(snapshot.leases, (item) => item.terminalId === event.terminalId);
      return;
    case "terminal-meta": {
      const terminal = snapshot.terminals.find((item) => item.terminalId === event.terminalId);
      if (terminal) terminal.meta = event.meta;
      return;
    }
  }
}

function upsert<T>(items: T[], matches: (item: T) => boolean, item: T): void {
  remove(items, matches);
  items.push(structuredClone(item));
}

function remove<T>(items: T[], matches: (item: T) => boolean): void {
  const index = items.findIndex(matches);
  if (index >= 0) items.splice(index, 1);
}

function waitForWebSocketOpen(websocket: WebSocket): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    websocket.once("open", resolvePromise);
    websocket.once("error", reject);
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  await exited;
}

function formatDiagnostics(lines: string[]): string {
  const text = lines.join("").trim();
  return text ? `\nAgent output:\n${text}` : "";
}

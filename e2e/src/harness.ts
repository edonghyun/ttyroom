import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  LEGACY_PROTOCOL_VERSION,
  decodeDataFrame,
  encodeDataFrame,
  parseServerMessage,
  serializeClientMessage,
  type LeaseResult,
  type RoomEvent,
  type RoomSnapshot,
  type ServerMessage,
} from "@ttyroom/protocol";
import { ServerProcess, type TestPolicy } from "./server-process.js";
import { TestProcess } from "./test-process.js";
import { waitUntil } from "./wait-until.js";
export { waitUntil } from "./wait-until.js";
import WebSocket, { type RawData } from "ws";

type Policy = TestPolicy;

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface TestRoom {
  roomId: string;
  name: string;
  token: string;
  joinUrl: string;
  baseUrl: string;
}

export interface ConnectorHandle {
  hostId: string;
  kill(signal?: NodeJS.Signals): void;
  exited(): boolean;
}

export interface ParticipantClient {
  clientId: string;
  snapshot(): RoomSnapshot;
  terminal(terminalId: number): RoomSnapshot["terminals"][number] | undefined;
  host(hostId: string): RoomSnapshot["hosts"][number] | undefined;
  leaseHolder(terminalId: number): string | undefined;
  openTerminal(hostId: string): Promise<number>;
  requestControl(terminalId: number): Promise<LeaseResult>;
  closeTerminal(terminalId: number): Promise<void>;
  requestResize(terminalId: number, cols: number, rows: number): void;
  changeTerminalMode(terminalId: number, mode: "exclusive" | "shared"): Promise<void>;
  renameTerminal(terminalId: number, title: string): Promise<void>;
  updateGeometry(
    terminalId: number,
    geometry: { x: number; y: number; width: number; height: number },
  ): Promise<void>;
  resyncOutput(terminalId: number): Promise<void>;
  sendInput(terminalId: number, text: string): void;
  outputText(terminalId: number): string;
  syncedSeq(terminalId: number): number;
  lastMessages(): ServerMessage[];
  outputSequences(terminalId: number): number[];
  close(): void;
  reconnect(): Promise<void>;
}

export interface TestServer {
  readonly processId: number | undefined;
  room(name?: string): Promise<TestRoom>;
  restart(downtimeMs?: number): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Given {
  server(policy?: Partial<Policy>): Promise<TestServer>;
  connector(room: TestRoom, name?: string): Promise<ConnectorHandle>;
  participant(room: TestRoom, name: string, clientId?: string): Promise<ParticipantClient>;
}

class E2eServer implements TestServer {
  private readonly children = new Set<TestProcess>();
  private readonly participants = new Set<WsParticipant>();
  private connectorStartup = Promise.resolve();
  private closed = false;

  constructor(private readonly running: ServerProcess) {}

  get processId(): number | undefined {
    return this.running.pid;
  }

  async room(name?: string): Promise<TestRoom> {
    const response = await fetch(`${this.running.baseUrl}/api/rooms`, {
      method: "POST",
      headers: name === undefined ? undefined : { "content-type": "application/json" },
      body: name === undefined ? undefined : JSON.stringify({ name }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 201) {
      throw new Error(`Room 생성 실패: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      roomId: string;
      name: string;
      token: string;
      joinUrl: string;
    };
    return { ...body, baseUrl: this.running.baseUrl };
  }

  async connector(room: TestRoom, name = "host"): Promise<ConnectorHandle> {
    // 공개 protocol에는 connector child PID와 hostId를 직접 상관하는 필드가 없다.
    // startup을 직렬화하면 각 observer가 본 다음 host-connected가 방금 띄운 child임이 확정된다.
    const previousStartup = this.connectorStartup;
    let releaseStartup: (() => void) | undefined;
    this.connectorStartup = new Promise<void>((resolveStartup) => {
      releaseStartup = resolveStartup;
    });
    await previousStartup;

    try {
      const observer = await this.participant(room, `observer-${name}`);
      const before = observer.lastMessages().length;
      const child = new TestProcess(
        [process.execPath, "e2e/fixtures/legacy-connector.mjs", room.joinUrl, name],
        WORKSPACE_ROOT,
        // Product shell compatibility is separate; acceptance probes use a stable POSIX shell.
        { ...process.env, SHELL: "/bin/sh", ENV: "", BASH_ENV: "" },
      );
      this.children.add(child);
      child.child.once("exit", () => this.children.delete(child));

      const connected = await observer.waitForMessage(
        (message) => message.type === "room-event" && message.event.kind === "host-connected",
        before,
        () => `Connector 연결 실패\n${child.diagnostics()}\n${this.running.diagnostics()}`,
        child,
      );
      if (connected.type !== "room-event" || connected.event.kind !== "host-connected") {
        throw new Error("host-connected 대기 결과가 계약과 다르다");
      }

      return {
        hostId: connected.event.host.hostId,
        kill: (signal = "SIGTERM") => child.child.kill(signal),
        exited: () => child.exited(),
      };
    } finally {
      releaseStartup?.();
    }
  }

  async participant(
    room: TestRoom,
    name: string,
    clientId: string = crypto.randomUUID(),
  ): Promise<WsParticipant> {
    const participant = await WsParticipant.connect(room, name, clientId);
    this.participants.add(participant);
    return participant;
  }

  async restart(downtimeMs = 0): Promise<void> {
    if (this.closed) throw new Error("닫힌 테스트 서버는 재시작할 수 없다");
    await this.running.restart(downtimeMs);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Stop the owned server before clients so teardown cannot mutate persistent room state.
    try {
      await this.running.close();
    } finally {
      serversByBaseUrl.delete(this.running.baseUrl);
      for (const participant of [...this.participants]) participant.close();
      await Promise.all([...this.children].map((child) => child.stop()));
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

class WsParticipant implements ParticipantClient {
  private readonly messages: ServerMessage[] = [];
  private readonly output = new Map<number, Array<{ seq: number; payload: Uint8Array }>>();
  private failure: Error | undefined;
  private readonly syncs = new Map<number, number>();
  private readonly leases = new Map<number, number>();
  private currentSnapshot: RoomSnapshot | undefined;
  private inputSeq = 0;
  private openTerminalQueue = Promise.resolve();

  private constructor(
    readonly clientId: string,
    private readonly room: TestRoom,
    private readonly name: string,
    private websocket: WebSocket,
  ) {
    this.attach(websocket);
  }

  static async connect(room: TestRoom, name: string, clientId: string): Promise<WsParticipant> {
    const websocket = new WebSocket(room.baseUrl.replace(/^http/, "ws") + "/ws", {
      handshakeTimeout: 5_000,
    });
    await waitForWebSocketOpen(websocket);
    const participant = new WsParticipant(clientId, room, name, websocket);
    try {
      await participant.join();
      return participant;
    } catch (error) {
      websocket.terminate();
      throw error;
    }
  }

  snapshot(): RoomSnapshot {
    if (!this.currentSnapshot) throw new Error("welcome snapshot을 아직 받지 못했다");
    return structuredClone(this.currentSnapshot);
  }

  terminal(terminalId: number): RoomSnapshot["terminals"][number] | undefined {
    return this.snapshot().terminals.find((terminal) => terminal.terminalId === terminalId);
  }

  host(hostId: string): RoomSnapshot["hosts"][number] | undefined {
    return this.snapshot().hosts.find((host) => host.hostId === hostId);
  }

  leaseHolder(terminalId: number): string | undefined {
    return this.snapshot().leases.find((lease) => lease.terminalId === terminalId)?.holderClientId;
  }

  async openTerminal(hostId: string): Promise<number> {
    // open-terminal-request/terminal-opened에는 requestId가 없으므로 한 participant의
    // 동시 요청은 직렬화해야 각 Promise가 서로 다른 응답을 소비한다.
    const previousOpen = this.openTerminalQueue;
    let releaseOpen: (() => void) | undefined;
    this.openTerminalQueue = new Promise<void>((resolveOpen) => {
      releaseOpen = resolveOpen;
    });
    await previousOpen;

    try {
      const before = this.messages.length;
      this.send({ type: "open-terminal-request", hostId });
      const opened = await this.waitForMessage(
        (message) =>
          message.type === "room-event" &&
          message.event.kind === "terminal-opened" &&
          message.event.terminal.hostId === hostId,
        before,
      );
      if (opened.type !== "room-event" || opened.event.kind !== "terminal-opened") {
        throw new Error("terminal-opened 대기 결과가 계약과 다르다");
      }
      return opened.event.terminal.terminalId;
    } finally {
      releaseOpen?.();
    }
  }

  async requestControl(terminalId: number): Promise<LeaseResult> {
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

  /** Queue a resize before subsequent input; the protocol has no resize completion response. */
  requestResize(terminalId: number, cols: number, rows: number): void {
    this.send({ type: "resize-request", terminalId, cols, rows });
  }

  async closeTerminal(terminalId: number): Promise<void> {
    const before = this.messages.length;
    this.send({ type: "close-terminal-request", terminalId });
    await this.waitForMessage(
      (message) =>
        message.type === "room-event" &&
        message.event.kind === "terminal-closed" &&
        message.event.terminalId === terminalId,
      before,
    );
  }

  async changeTerminalMode(terminalId: number, mode: "exclusive" | "shared"): Promise<void> {
    const before = this.messages.length;
    this.send({ type: "set-terminal-mode", terminalId, mode });
    await this.waitForMessage(
      (message) =>
        message.type === "room-event" &&
        message.event.kind === "terminal-mode-changed" &&
        message.event.terminalId === terminalId &&
        message.event.mode === mode,
      before,
    );
  }

  async renameTerminal(terminalId: number, title: string): Promise<void> {
    const before = this.messages.length;
    this.send({ type: "rename-terminal", terminalId, title });
    await this.waitForMessage(
      (message) =>
        message.type === "room-event" &&
        message.event.kind === "terminal-renamed" &&
        message.event.terminalId === terminalId &&
        message.event.title === title,
      before,
    );
  }

  async updateGeometry(
    terminalId: number,
    geometry: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    const before = this.messages.length;
    this.send({ type: "update-terminal-geometry", terminalId, geometry });
    await this.waitForMessage(
      (message) =>
        message.type === "room-event" &&
        message.event.kind === "terminal-geometry-changed" &&
        message.event.terminalId === terminalId,
      before,
    );
  }

  async resyncOutput(terminalId: number): Promise<void> {
    const before = this.messages.length;
    this.output.delete(terminalId);
    this.syncs.delete(terminalId);
    this.send({ type: "resync-output-request", terminalId });
    await this.waitForMessage(
      (message) => message.type === "sync" && message.terminalId === terminalId,
      before,
    );
  }

  sendInput(terminalId: number, text: string): void {
    const leaseId =
      this.leases.get(terminalId) ?? (this.terminal(terminalId)?.mode === "shared" ? 0 : undefined);
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
    if (this.failure) throw this.failure;
    const chunks = (this.output.get(terminalId) ?? []).map((frame) => frame.payload);
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  }

  outputSequences(terminalId: number): number[] {
    return (this.output.get(terminalId) ?? []).map((frame) => frame.seq);
  }

  syncedSeq(terminalId: number): number {
    return this.syncs.get(terminalId) ?? 0;
  }

  lastMessages(): ServerMessage[] {
    return structuredClone(this.messages);
  }

  close(): void {
    if (
      this.websocket.readyState === WebSocket.OPEN ||
      this.websocket.readyState === WebSocket.CONNECTING
    ) {
      this.websocket.close();
    }
  }

  async reconnect(): Promise<void> {
    if (this.websocket.readyState !== WebSocket.CLOSED) {
      await waitForWebSocketClose(this.websocket);
    }
    const websocket = new WebSocket(this.room.baseUrl.replace(/^http/, "ws") + "/ws", {
      handshakeTimeout: 5_000,
    });
    await waitForWebSocketOpen(websocket);
    this.websocket = websocket;
    this.failure = undefined;
    this.attach(websocket);
    await this.join();
  }

  async waitForMessage(
    predicate: (message: ServerMessage) => boolean,
    afterIndex: number,
    failure?: () => string,
    child?: TestProcess,
  ): Promise<ServerMessage> {
    await waitUntil(
      () => {
        if (this.failure) throw this.failure;
        if (this.messages.slice(afterIndex).some(predicate)) return true;
        const rejected = this.messages
          .slice(afterIndex)
          .find((message) => message.type === "error");
        if (rejected?.type === "error")
          throw new Error(`server rejected request: ${rejected.code}`);
        if (child?.exited()) throw new Error(failure?.() ?? child.diagnostics());
        if (this.websocket.readyState === WebSocket.CLOSED)
          throw new Error("connection closed before response");
        return false;
      },
      {
        failure: () =>
          failure?.() ?? `서버 응답 대기 실패: ${JSON.stringify(this.messages.slice(-10))}`,
      },
    );
    const message = this.messages.slice(afterIndex).find(predicate);
    if (!message) throw new Error(failure?.() ?? "기대한 서버 메시지가 도착하지 않았다");
    return message;
  }

  private send(message: Parameters<typeof serializeClientMessage>[0]): void {
    this.websocket.send(serializeClientMessage(message));
  }

  private async join(): Promise<void> {
    const before = this.messages.length;
    this.send({
      type: "hello",
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      roomId: this.room.roomId,
      token: this.room.token,
      clientId: this.clientId,
      name: this.name,
      role: "participant",
    });
    await this.waitForMessage((message) => message.type === "welcome", before);
  }

  private attach(websocket: WebSocket): void {
    websocket.on("error", (error) => {
      if (this.websocket === websocket) this.failure = error;
    });
    websocket.on("message", (raw, isBinary) => {
      if (this.websocket !== websocket) return;
      try {
        this.receive(raw, isBinary);
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  private receive(raw: RawData, isBinary: boolean): void {
    if (isBinary) {
      const bytes =
        raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as Buffer);
      const decoded = decodeDataFrame(bytes);
      if (decoded.kind !== "ok" || decoded.frame.kind !== "output")
        throw new Error("서버가 잘못된 output frame을 보냈다");
      const frames = this.output.get(decoded.frame.terminalId) ?? [];
      frames.push({ seq: decoded.frame.seq, payload: decoded.frame.payload });
      this.output.set(decoded.frame.terminalId, frames);
      return;
    }

    const parsed = parseServerMessage(raw.toString());
    if (parsed.kind !== "ok")
      throw new Error(`서버가 잘못된 제어 메시지를 보냈다: ${parsed.reason}`);
    const message = parsed.message;
    this.messages.push(message);
    if (message.type === "welcome") {
      this.currentSnapshot = structuredClone(message.snapshot);
      this.output.clear();
      this.syncs.clear();
      this.leases.clear();
      for (const lease of message.snapshot.leases) {
        if (lease.holderClientId === this.clientId) {
          this.leases.set(lease.terminalId, lease.leaseId);
        }
      }
    }
    if (message.type === "room-event" && this.currentSnapshot) {
      applyRoomEvent(this.currentSnapshot, message.event);
    }
    if (message.type === "sync") this.syncs.set(message.terminalId, message.seq);
  }
}

export const given: Given = {
  async server(policy = {}): Promise<E2eServer> {
    const running = await ServerProcess.start(policy, { protocolVersion: 7 });
    const server = new E2eServer(running);
    serversByBaseUrl.set(running.baseUrl, server);
    return server;
  },
  connector(room, name): Promise<ConnectorHandle> {
    return serverFor(room).connector(room, name);
  },
  participant(room, name, clientId): Promise<ParticipantClient> {
    return serverFor(room).participant(room, name, clientId);
  },
};

const serversByBaseUrl = new Map<string, E2eServer>();

function serverFor(room: TestRoom): E2eServer {
  const server = serversByBaseUrl.get(room.baseUrl);
  if (!server) throw new Error(`room 소유 server가 없거나 닫혔다: ${room.baseUrl}`);
  return server;
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
      for (const terminal of snapshot.terminals.filter((item) => item.hostId === event.hostId)) {
        remove(snapshot.leases, (item) => item.terminalId === terminal.terminalId);
      }
      remove(snapshot.terminals, (item) => item.hostId === event.hostId, true);
      return;
    case "host-input-state-changed": {
      const host = snapshot.hosts.find((item) => item.hostId === event.hostId);
      if (host) host.remoteInputAllowed = event.remoteInputAllowed;
      return;
    }
    case "terminal-opened":
      upsert(
        snapshot.terminals,
        (item) => item.terminalId === event.terminal.terminalId,
        event.terminal,
      );
      return;
    case "terminal-mode-changed": {
      const terminal = snapshot.terminals.find((item) => item.terminalId === event.terminalId);
      if (terminal) terminal.mode = event.mode;
      return;
    }
    case "terminal-renamed": {
      const terminal = snapshot.terminals.find((item) => item.terminalId === event.terminalId);
      if (terminal) terminal.title = event.title;
      return;
    }
    case "terminal-geometry-changed": {
      const terminal = snapshot.terminals.find((item) => item.terminalId === event.terminalId);
      if (terminal) terminal.geometry = event.geometry;
      return;
    }
    case "participant-focus-changed": {
      const participant = snapshot.participants.find((item) => item.clientId === event.clientId);
      if (participant) participant.focusedTerminalId = event.focusedTerminalId;
      return;
    }
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

function remove<T>(items: T[], matches: (item: T) => boolean, all = false): void {
  let index = items.findIndex(matches);
  while (index >= 0) {
    items.splice(index, 1);
    if (!all) return;
    index = items.findIndex(matches);
  }
}

function waitForWebSocketOpen(websocket: WebSocket): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const opened = (): void => {
      websocket.off("error", failed);
      websocket.off("close", closed);
      resolvePromise();
    };
    const failed = (error: Error): void => {
      websocket.off("open", opened);
      websocket.off("close", closed);
      reject(error);
    };
    const closed = (): void => failed(new Error("connection closed before open"));
    websocket.once("open", opened);
    websocket.once("error", failed);
    websocket.once("close", closed);
  });
}

async function waitForWebSocketClose(websocket: WebSocket): Promise<void> {
  try {
    await waitUntil(() => websocket.readyState === WebSocket.CLOSED, {
      timeoutMs: 5_000,
      failure: () => "WebSocket close timed out before reconnect",
    });
  } catch (error) {
    websocket.terminate();
    throw error;
  }
}

import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  LeaseView,
  RoomSnapshot,
  TerminalGeometry,
  TerminalMeta,
  TerminalView,
} from "@ttyroom/protocol";

// 스펙 불변식: exclusive 터미널 유효 임대 최대 1·선착순·1인 1임대(새 획득 시 기존 자동 해제)·재도착 멱등
export type AcquireDecision =
  | { kind: "granted"; lease: LeaseView; autoReleased: LeaseView | null }
  | { kind: "already-held"; lease: LeaseView }
  | { kind: "denied"; holderClientId: string }
  | { kind: "rejected"; reason: "terminal-not-open" | "shared-terminal" };

export type ReleaseDecision = { kind: "released"; lease: LeaseView } | { kind: "not-holder" };

export const DEFAULT_ROOM_NAME = "Quick Room";

export interface StoredRoomRecord {
  schemaVersion: 1;
  roomId: string;
  tokenHash: string;
  name: string;
  nextTerminalId: number;
  hosts: Array<{ hostId: string; name: string }>;
  terminals: Array<{ view: TerminalView; runtimeId: string | null }>;
}

export interface HostTerminalInventoryItem {
  terminalId: number;
  runtimeId: string;
}

export interface HostTerminalReconciliation {
  activeTerminalIds: number[];
  closedTerminalIds: number[];
  agentTerminalIdsToClose: number[];
  recoveredTerminals: TerminalView[];
}

export interface StagedRoomChange<T> {
  readonly result: T;
  readonly record: StoredRoomRecord;
  commit(): void;
}

interface RoomState {
  participants: Map<string, { name: string; focusedTerminalId: number | null }>;
  hosts: Map<string, { name: string; online: boolean; remoteInputAllowed: boolean }>;
  terminals: Map<number, TerminalView>;
  runtimeIdByTerminal: Map<number, string>;
  leases: Map<number, LeaseView>;
  nextTerminalId: number;
  nextLeaseId: number;
}

export class Room {
  readonly roomId: string;
  readonly name: string;
  private readonly tokenHash: string;
  private readonly participants = new Map<
    string,
    { name: string; focusedTerminalId: number | null }
  >();
  private readonly hosts = new Map<
    string,
    { name: string; online: boolean; remoteInputAllowed: boolean }
  >();
  private readonly terminals = new Map<number, TerminalView>();
  private readonly runtimeIdByTerminal = new Map<number, string>();
  private readonly leases = new Map<number, LeaseView>();
  private nextTerminalId = 1;
  private nextLeaseId = 1;

  constructor(
    options: { roomId: string; name?: string } & ({ token: string } | { tokenHash: string }),
  ) {
    this.roomId = options.roomId;
    this.tokenHash = "tokenHash" in options ? options.tokenHash : digestRoomToken(options.token);
    this.name = options.name ?? DEFAULT_ROOM_NAME;
  }

  static restore(record: StoredRoomRecord): Room {
    const room = new Room({
      roomId: record.roomId,
      tokenHash: record.tokenHash,
      name: record.name,
    });
    room.nextTerminalId = record.nextTerminalId;
    for (const host of record.hosts) {
      room.hosts.set(host.hostId, {
        name: host.name,
        online: false,
        remoteInputAllowed: false,
      });
    }
    for (const terminal of record.terminals) {
      room.terminals.set(terminal.view.terminalId, copyOfTerminal(terminal.view));
      if (terminal.runtimeId !== null) {
        room.runtimeIdByTerminal.set(terminal.view.terminalId, terminal.runtimeId);
      }
    }
    return room;
  }

  record(): StoredRoomRecord {
    return {
      schemaVersion: 1,
      roomId: this.roomId,
      tokenHash: this.tokenHash,
      name: this.name,
      nextTerminalId: this.nextTerminalId,
      hosts: [...this.hosts].map(([hostId, host]) => ({ hostId, name: host.name })),
      terminals: [...this.terminals.values()].map((view) => ({
        view: copyOfTerminal(view),
        runtimeId: this.runtimeIdByTerminal.get(view.terminalId) ?? null,
      })),
    };
  }

  stageDurableChange<T>(change: (draft: Room) => T): StagedRoomChange<T> {
    const before = this.captureState();
    const draft = new Room({ roomId: this.roomId, tokenHash: this.tokenHash, name: this.name });
    draft.restoreState(this.captureState());
    const result = change(draft);
    const after = draft.captureState();
    return {
      result,
      record: draft.record(),
      commit: () => this.applyChanges(before, after),
    };
  }

  matchesToken(candidate: string): boolean {
    const expected = Buffer.from(this.tokenHash, "hex");
    const actual = Buffer.from(digestRoomToken(candidate), "hex");
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }

  addParticipant(clientId: string, name: string): void {
    const current = this.participants.get(clientId);
    this.participants.set(clientId, {
      name,
      focusedTerminalId: current?.focusedTerminalId ?? null,
    });
  }

  hasParticipant(clientId: string): boolean {
    return this.participants.has(clientId);
  }

  focusParticipant(
    clientId: string,
    terminalId: number | null,
  ): "changed" | "unchanged" | "rejected" {
    const participant = this.participants.get(clientId);
    if (!participant) throw new Error(`참여자가 아닌 clientId의 focus 보고: ${clientId}`);
    if (terminalId !== null && !this.terminals.has(terminalId)) return "rejected";
    if (participant.focusedTerminalId === terminalId) return "unchanged";

    participant.focusedTerminalId = terminalId;
    return "changed";
  }

  // 떠난 참여자의 임대는 무효 — stale lease가 남지 않게 걷어서 반환한다 (removeHost와 대칭).
  // 유예 중 단절 참여자는 아직 참여자라 여기 오지 않는다 — 유예 복원(T2.9)과 충돌 없음
  removeParticipant(clientId: string): LeaseView[] {
    this.participants.delete(clientId);
    return this.releaseAllOf(clientId);
  }

  connectHost(hostId: string, name: string): void {
    const existing = this.hosts.get(hostId);
    this.hosts.set(hostId, {
      name,
      online: true,
      remoteInputAllowed: existing?.remoteInputAllowed ?? true,
    });
  }

  beginHostRecovery(hostId: string, name: string): void {
    this.connectHost(hostId, name);
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`방금 연결한 host가 없다: ${hostId}`);
    host.online = false;
    host.remoteInputAllowed = false;
  }

  setHostRemoteInputAllowed(hostId: string, remoteInputAllowed: boolean): boolean {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`등록되지 않은 host의 원격 입력 상태를 바꿀 수 없다: ${hostId}`);
    if (host.remoteInputAllowed === remoteInputAllowed) return false;
    host.remoteInputAllowed = remoteInputAllowed;
    return true;
  }

  isHostRemoteInputAllowed(hostId: string): boolean {
    return this.hosts.get(hostId)?.remoteInputAllowed ?? false;
  }

  openTerminal(hostId: string): TerminalView {
    if (!this.hosts.has(hostId)) {
      throw new Error(`등록되지 않은 host에 터미널을 열 수 없다: ${hostId}`);
    }

    const terminalId = this.nextTerminalId;
    this.nextTerminalId += 1;

    const view: TerminalView = {
      terminalId,
      hostId,
      title: `term-${terminalId}`,
      geometry: initialTerminalGeometry(terminalId),
      mode: "exclusive",
      status: "open",
      exitCode: null,
      meta: { cwd: null, gitBranch: null, fgProcess: null },
    };
    this.terminals.set(terminalId, view);
    return copyOfTerminal(view);
  }

  markHostOffline(hostId: string): void {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`등록되지 않은 host를 offline으로 표시할 수 없다: ${hostId}`);

    host.online = false;
  }

  removeHost(hostId: string): number[] {
    if (!this.hosts.has(hostId)) {
      throw new Error(`등록되지 않은 host를 제거할 수 없다: ${hostId}`);
    }

    this.hosts.delete(hostId);

    const removed: number[] = [];
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.hostId === hostId) {
        this.terminals.delete(terminalId);
        this.runtimeIdByTerminal.delete(terminalId);
        // 터미널이 사라지면 그 임대도 무효 — stale lease가 스냅샷에 남지 않게 함께 걷는다
        this.leases.delete(terminalId);
        removed.push(terminalId);
      }
    }
    return removed;
  }

  // 모드 전환은 임대에 관여하지 않는다 — shared 동안 입력권은 isInputAllowed의 shared 분기가
  // 결정하고, exclusive 복귀 시 보존된 임대가 그대로 유효하다 (해제된 적 없으니 현재 임대)
  setTerminalMode(terminalId: number, mode: "exclusive" | "shared"): boolean {
    const terminal = this.requireTerminal(terminalId);
    if (terminal.mode === mode) return false;
    terminal.mode = mode;
    return true;
  }

  // 임대는 걷지 않는다 — exited 입력은 isInputAllowed가 차단하고,
  // 임대 수명은 소유자 이탈(removeParticipant)·터미널 제거(removeHost) 경로가 관리한다
  markTerminalExited(terminalId: number, exitCode: number | null): void {
    const terminal = this.requireTerminal(terminalId);
    terminal.status = "exited";
    terminal.exitCode = exitCode;
    this.runtimeIdByTerminal.delete(terminalId);
  }

  confirmTerminalOpened(terminalId: number, runtimeId: string): void {
    const terminal = this.requireTerminal(terminalId);
    if (terminal.status !== "open") return;
    this.runtimeIdByTerminal.set(terminalId, runtimeId);
  }

  terminalRuntimeId(terminalId: number): string | null {
    return this.runtimeIdByTerminal.get(terminalId) ?? null;
  }

  reconcileHostTerminals(
    hostId: string,
    inventory: readonly HostTerminalInventoryItem[],
  ): HostTerminalReconciliation {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`등록되지 않은 host의 터미널을 조정할 수 없다: ${hostId}`);

    const reported = new Map(inventory.map((item) => [item.terminalId, item]));
    const activeTerminalIds: number[] = [];
    const closedTerminalIds: number[] = [];
    const agentTerminalIdsToClose = new Set<number>();
    const recoveredTerminals: TerminalView[] = [];

    for (const terminal of this.terminals.values()) {
      if (terminal.hostId !== hostId || terminal.status !== "open") continue;
      const item = reported.get(terminal.terminalId);
      const expectedRuntimeId = this.runtimeIdByTerminal.get(terminal.terminalId);
      if (item && (!expectedRuntimeId || expectedRuntimeId === item.runtimeId)) {
        this.runtimeIdByTerminal.set(terminal.terminalId, item.runtimeId);
        activeTerminalIds.push(terminal.terminalId);
        reported.delete(terminal.terminalId);
        continue;
      }

      this.markTerminalExited(terminal.terminalId, null);
      closedTerminalIds.push(terminal.terminalId);
      if (item) agentTerminalIdsToClose.add(terminal.terminalId);
      reported.delete(terminal.terminalId);
    }

    for (const item of reported.values()) {
      if (this.terminals.has(item.terminalId)) {
        agentTerminalIdsToClose.add(item.terminalId);
        continue;
      }
      const view: TerminalView = {
        terminalId: item.terminalId,
        hostId,
        title: `term-${item.terminalId}`,
        geometry: initialTerminalGeometry(item.terminalId),
        mode: "exclusive",
        status: "open",
        exitCode: null,
        meta: { cwd: null, gitBranch: null, fgProcess: null },
      };
      this.terminals.set(item.terminalId, view);
      this.runtimeIdByTerminal.set(item.terminalId, item.runtimeId);
      this.nextTerminalId = Math.max(this.nextTerminalId, item.terminalId + 1);
      activeTerminalIds.push(item.terminalId);
      recoveredTerminals.push(copyOfTerminal(view));
    }

    host.online = true;
    host.remoteInputAllowed = false;
    return {
      activeTerminalIds,
      closedTerminalIds,
      agentTerminalIdsToClose: [...agentTerminalIdsToClose],
      recoveredTerminals,
    };
  }

  updateTerminalMeta(terminalId: number, meta: TerminalMeta): void {
    this.requireTerminal(terminalId).meta = { ...meta };
  }

  updateTerminalGeometry(terminalId: number, geometry: TerminalGeometry): void {
    this.requireTerminal(terminalId).geometry = { ...geometry };
  }

  renameTerminal(terminalId: number, title: string): boolean {
    const terminal = this.requireTerminal(terminalId);
    if (terminal.title === title) return false;
    terminal.title = title;
    return true;
  }

  terminal(terminalId: number): TerminalView | undefined {
    const terminal = this.terminals.get(terminalId);
    return terminal && copyOfTerminal(terminal);
  }

  private requireTerminal(terminalId: number): TerminalView {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`존재하지 않는 터미널: ${terminalId}`);
    return terminal;
  }

  acquireLease(clientId: string, terminalId: number): AcquireDecision {
    // 미등록 clientId가 여기까지 오면 유즈케이스(hello/등록) 버그 — 도메인 불변식 위반은 throw
    if (!this.participants.has(clientId)) {
      throw new Error(`참여자가 아닌 clientId의 임대 요청: ${clientId}`);
    }

    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.status !== "open") {
      return { kind: "rejected", reason: "terminal-not-open" };
    }
    if (terminal.mode === "shared") {
      return { kind: "rejected", reason: "shared-terminal" };
    }

    const existing = this.leases.get(terminalId);
    if (existing) {
      // 반환 lease는 구조 복사 — 소비자가 내부 임대 상태를 변경하지 못하게 차단
      if (existing.holderClientId === clientId)
        return { kind: "already-held", lease: { ...existing } };
      return { kind: "denied", holderClientId: existing.holderClientId };
    }

    // 1인 1임대 — 기존 임대는 최대 1개(이 메서드가 유일한 발급 지점)라 [0]이 전부다
    const autoReleased = this.releaseAllOf(clientId)[0] ?? null;

    const lease: LeaseView = { terminalId, leaseId: this.nextLeaseId, holderClientId: clientId };
    this.nextLeaseId += 1;
    this.leases.set(terminalId, lease);
    return { kind: "granted", lease: { ...lease }, autoReleased };
  }

  releaseAllOf(clientId: string): LeaseView[] {
    const released: LeaseView[] = [];
    for (const [terminalId, lease] of this.leases) {
      if (lease.holderClientId === clientId) {
        this.leases.delete(terminalId);
        released.push(lease);
      }
    }
    return released;
  }

  releaseLease(clientId: string, terminalId: number): ReleaseDecision {
    const lease = this.leases.get(terminalId);
    if (!lease || lease.holderClientId !== clientId) return { kind: "not-holder" };

    this.leases.delete(terminalId);
    return { kind: "released", lease };
  }

  leaseOf(terminalId: number): LeaseView | undefined {
    const lease = this.leases.get(terminalId);
    // 구조 복사 — 소비자가 반환된 뷰로 내부 상태를 변경하지 못하게 차단
    return lease && { ...lease };
  }

  isInputAllowed(clientId: string, terminalId: number, leaseId: number): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.status !== "open") return false;

    if (terminal.mode === "shared") return this.hasParticipant(clientId);

    const lease = this.leases.get(terminalId);
    return !!lease && lease.holderClientId === clientId && lease.leaseId === leaseId;
  }

  isEmpty(): boolean {
    const hasOnlineHost = [...this.hosts.values()].some((h) => h.online);
    return this.participants.size === 0 && !hasOnlineHost;
  }

  snapshot(): RoomSnapshot {
    return {
      roomId: this.roomId,
      name: this.name,
      participants: [...this.participants].map(([clientId, p]) => ({
        clientId,
        name: p.name,
        focusedTerminalId: p.focusedTerminalId,
      })),
      hosts: [...this.hosts].map(([hostId, h]) => ({
        hostId,
        name: h.name,
        online: h.online,
        remoteInputAllowed: h.remoteInputAllowed,
      })),
      terminals: [...this.terminals.values()].map(copyOfTerminal),
      // LeaseView 필드는 전부 원시값 — 이 깊이의 복사로 내부 상태 역참조가 없다
      leases: [...this.leases.values()].map((l) => ({ ...l })),
    };
  }

  private captureState(): RoomState {
    return {
      participants: new Map(
        [...this.participants].map(([clientId, participant]) => [clientId, { ...participant }]),
      ),
      hosts: new Map([...this.hosts].map(([hostId, host]) => [hostId, { ...host }])),
      terminals: new Map(
        [...this.terminals].map(([terminalId, terminal]) => [terminalId, copyOfTerminal(terminal)]),
      ),
      runtimeIdByTerminal: new Map(this.runtimeIdByTerminal),
      leases: new Map([...this.leases].map(([terminalId, lease]) => [terminalId, { ...lease }])),
      nextTerminalId: this.nextTerminalId,
      nextLeaseId: this.nextLeaseId,
    };
  }

  private restoreState(state: RoomState): void {
    replaceMap(this.participants, state.participants);
    replaceMap(this.hosts, state.hosts);
    replaceMap(this.terminals, state.terminals);
    replaceMap(this.runtimeIdByTerminal, state.runtimeIdByTerminal);
    replaceMap(this.leases, state.leases);
    this.nextTerminalId = state.nextTerminalId;
    this.nextLeaseId = state.nextLeaseId;
  }

  private applyChanges(before: RoomState, after: RoomState): void {
    applyMapChanges(this.participants, before.participants, after.participants, (value) => ({
      ...value,
    }));
    applyMapChanges(this.hosts, before.hosts, after.hosts, (value) => ({ ...value }));
    applyMapChanges(this.terminals, before.terminals, after.terminals, copyOfTerminal);
    applyMapChanges(
      this.runtimeIdByTerminal,
      before.runtimeIdByTerminal,
      after.runtimeIdByTerminal,
      (value) => value,
    );
    applyMapChanges(this.leases, before.leases, after.leases, (value) => ({ ...value }));
    if (before.nextTerminalId !== after.nextTerminalId) {
      this.nextTerminalId = after.nextTerminalId;
    }
    if (before.nextLeaseId !== after.nextLeaseId) this.nextLeaseId = after.nextLeaseId;
  }
}

// 구조 복사 — Room 밖으로 나가는 터미널 뷰가 내부 상태로의 역참조를 갖지 않게 차단
function copyOfTerminal(view: TerminalView): TerminalView {
  return { ...view, geometry: { ...view.geometry }, meta: { ...view.meta } };
}

function initialTerminalGeometry(terminalId: number): TerminalGeometry {
  const offset = (terminalId - 1) * 32;
  return { x: 24 + offset, y: 24 + offset, width: 640, height: 420 };
}

function digestRoomToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function applyMapChanges<K, V>(
  target: Map<K, V>,
  before: Map<K, V>,
  after: Map<K, V>,
  copy: (value: V) => V,
): void {
  for (const key of before.keys()) {
    if (!after.has(key)) target.delete(key);
  }
  for (const [key, value] of after) {
    if (!before.has(key) || !isDeepStrictEqual(before.get(key), value)) {
      target.set(key, copy(value));
    }
  }
}

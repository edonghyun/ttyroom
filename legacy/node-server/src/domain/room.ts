import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  LeaseControl,
  type Lease,
  type LeaseControlState,
  type ReleaseDecision,
} from "./lease-control.js";
import { Presence, type ParticipantState, type PresenceState } from "./presence.js";
import {
  TerminalWorkspace,
  type HostState,
  type HostTerminalInventoryItem,
  type HostTerminalReconciliation,
  type TerminalGeometry,
  type TerminalMetadata,
  type TerminalState,
  type TerminalWorkspaceState,
} from "./terminal-workspace.js";

export { TerminalIdsExhausted } from "./terminal-workspace.js";
export type { Lease, ReleaseDecision } from "./lease-control.js";
export type { ParticipantState } from "./presence.js";
export type {
  HostState,
  HostTerminalInventoryItem,
  HostTerminalReconciliation,
  TerminalGeometry,
  TerminalMetadata,
  TerminalState,
} from "./terminal-workspace.js";

export interface RoomState {
  roomId: string;
  name: string;
  participants: ParticipantState[];
  hosts: HostState[];
  terminals: TerminalState[];
  leases: Lease[];
}

// 스펙 불변식: exclusive 터미널 유효 임대 최대 1·선착순·1인 1임대(새 획득 시 기존 자동 해제)·재도착 멱등
export type AcquireDecision =
  | { kind: "granted"; lease: Lease; autoReleased: Lease | null }
  | { kind: "already-held"; lease: Lease }
  | { kind: "denied"; holderClientId: string }
  | { kind: "rejected"; reason: "terminal-not-open" | "shared-terminal" };

export const DEFAULT_ROOM_NAME = "Quick Room";

export interface StoredRoomRecord {
  schemaVersion: 1;
  roomId: string;
  tokenHash: string;
  name: string;
  nextTerminalId: number;
  hosts: Array<{ hostId: string; name: string }>;
  terminals: Array<{ view: TerminalState; runtimeId: string | null }>;
}

export interface StagedRoomChange<T> {
  readonly result: T;
  readonly recordToSave: StoredRoomRecord | null;
  commit(): void;
}

interface RoomInternals {
  presence: PresenceState;
  workspace: TerminalWorkspaceState;
  leaseControl: LeaseControlState;
}

/**
 * Aggregate boundary for a collaborative room.
 *
 * Callers express room-level intent here. Presence, terminal workspace, and lease bookkeeping
 * remain hidden so cross-capability invariants cannot depend on caller-controlled call order.
 */
export class Room {
  readonly roomId: string;
  readonly name: string;
  private readonly tokenHash: string;
  private readonly presence = new Presence();
  private readonly workspace = new TerminalWorkspace();
  private readonly leaseControl = new LeaseControl();

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
    room.workspace.restoreRecord(record);
    return room;
  }

  record(): StoredRoomRecord {
    const workspace = this.workspace.record();
    return {
      schemaVersion: 1,
      roomId: this.roomId,
      tokenHash: this.tokenHash,
      name: this.name,
      ...workspace,
    };
  }

  stageChange<T>(change: (draft: Room) => T): StagedRoomChange<T> {
    const before = this.captureState();
    const recordBefore = this.record();
    const draft = new Room({ roomId: this.roomId, tokenHash: this.tokenHash, name: this.name });
    draft.restoreState(before);
    const result = change(draft);
    const after = draft.captureState();
    const recordAfter = draft.record();
    return {
      result,
      recordToSave: isDeepStrictEqual(recordBefore, recordAfter) ? null : recordAfter,
      commit: () => this.applyChanges(before, after),
    };
  }

  matchesToken(candidate: string): boolean {
    const expected = Buffer.from(this.tokenHash, "hex");
    const actual = Buffer.from(digestRoomToken(candidate), "hex");
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }

  addParticipant(clientId: string, name: string): void {
    this.presence.add(clientId, name);
  }

  hasParticipant(clientId: string): boolean {
    return this.presence.has(clientId);
  }

  focusParticipant(
    clientId: string,
    terminalId: number | null,
  ): "changed" | "unchanged" | "rejected" {
    if (!this.presence.has(clientId)) {
      throw new Error(`참여자가 아닌 clientId의 focus 보고: ${clientId}`);
    }
    if (terminalId !== null && !this.workspace.hasTerminal(terminalId)) return "rejected";
    return this.presence.focus(clientId, terminalId);
  }

  // Presence와 LeaseControl을 함께 닫아 stale lease를 남기지 않는다.
  // 유예 중 단절 참여자는 아직 참여자라 여기 오지 않는다 — 유예 복원(T2.9)과 충돌 없음.
  removeParticipant(clientId: string): Lease[] {
    this.presence.remove(clientId);
    return this.leaseControl.releaseAllOf(clientId);
  }

  connectHost(hostId: string, name: string): void {
    this.workspace.connectHost(hostId, name);
  }

  beginHostRecovery(hostId: string, name: string): void {
    this.workspace.beginHostRecovery(hostId, name);
  }

  setHostRemoteInputAllowed(hostId: string, remoteInputAllowed: boolean): boolean {
    return this.workspace.setHostRemoteInputAllowed(hostId, remoteInputAllowed);
  }

  isHostRemoteInputAllowed(hostId: string): boolean {
    return this.workspace.isHostRemoteInputAllowed(hostId);
  }

  openTerminal(hostId: string): TerminalState {
    return this.workspace.openTerminal(hostId);
  }

  markHostOffline(hostId: string): void {
    this.workspace.markHostOffline(hostId);
  }

  // Workspace와 LeaseControl을 함께 닫아 제거된 terminal의 stale lease를 남기지 않는다.
  removeHost(hostId: string): number[] {
    const terminalIds = this.workspace.removeHost(hostId);
    this.leaseControl.removeTerminals(terminalIds);
    return terminalIds;
  }

  // 모드 전환은 임대에 관여하지 않는다. shared 동안 입력권은 isInputAllowed가 결정하고,
  // exclusive 복귀 시 보존된 임대가 그대로 유효하다.
  setTerminalMode(terminalId: number, mode: "exclusive" | "shared"): boolean {
    return this.workspace.setTerminalMode(terminalId, mode);
  }

  // 임대는 걷지 않는다. exited 입력은 isInputAllowed가 차단하고,
  // 임대 수명은 소유자 이탈·터미널 제거 경로가 관리한다.
  markTerminalExited(terminalId: number, exitCode: number | null): void {
    this.workspace.markTerminalExited(terminalId, exitCode);
  }

  confirmTerminalOpened(terminalId: number, runtimeId: string): void {
    this.workspace.confirmTerminalOpened(terminalId, runtimeId);
  }

  terminalRuntimeId(terminalId: number): string | null {
    return this.workspace.terminalRuntimeId(terminalId);
  }

  reconcileHostTerminals(
    hostId: string,
    inventory: readonly HostTerminalInventoryItem[],
  ): HostTerminalReconciliation {
    return this.workspace.reconcileHostTerminals(hostId, inventory);
  }

  updateTerminalMeta(terminalId: number, meta: TerminalMetadata): void {
    this.workspace.updateTerminalMeta(terminalId, meta);
  }

  updateTerminalGeometry(terminalId: number, geometry: TerminalGeometry): void {
    this.workspace.updateTerminalGeometry(terminalId, geometry);
  }

  renameTerminal(terminalId: number, title: string): boolean {
    return this.workspace.renameTerminal(terminalId, title);
  }

  terminal(terminalId: number): TerminalState | undefined {
    return this.workspace.terminal(terminalId);
  }

  acquireLease(clientId: string, terminalId: number): AcquireDecision {
    // 미등록 clientId가 여기까지 오면 유즈케이스(hello/등록) 버그 — 도메인 불변식 위반은 throw.
    if (!this.presence.has(clientId)) {
      throw new Error(`참여자가 아닌 clientId의 임대 요청: ${clientId}`);
    }

    const inputMode = this.workspace.inputMode(terminalId);
    if (inputMode === null) return { kind: "rejected", reason: "terminal-not-open" };
    if (inputMode === "shared") return { kind: "rejected", reason: "shared-terminal" };
    return this.leaseControl.acquire(clientId, terminalId);
  }

  releaseAllOf(clientId: string): Lease[] {
    return this.leaseControl.releaseAllOf(clientId);
  }

  releaseLease(clientId: string, terminalId: number): ReleaseDecision {
    return this.leaseControl.release(clientId, terminalId);
  }

  leaseOf(terminalId: number): Lease | undefined {
    return this.leaseControl.leaseOf(terminalId);
  }

  isInputAllowed(clientId: string, terminalId: number, leaseId: number): boolean {
    const inputMode = this.workspace.inputMode(terminalId);
    if (inputMode === null) return false;
    if (inputMode === "shared") return this.presence.has(clientId);
    return this.leaseControl.isHeldBy(clientId, terminalId, leaseId);
  }

  isEmpty(): boolean {
    return this.presence.isEmpty() && !this.workspace.hasOnlineHost();
  }

  snapshot(): RoomState {
    return {
      roomId: this.roomId,
      name: this.name,
      participants: this.presence.snapshot(),
      hosts: this.workspace.hostSnapshot(),
      terminals: this.workspace.terminalSnapshot(),
      leases: this.leaseControl.snapshot(),
    };
  }

  private captureState(): RoomInternals {
    return {
      presence: this.presence.captureState(),
      workspace: this.workspace.captureState(),
      leaseControl: this.leaseControl.captureState(),
    };
  }

  private restoreState(state: RoomInternals): void {
    this.presence.restoreState(state.presence);
    this.workspace.restoreState(state.workspace);
    this.leaseControl.restoreState(state.leaseControl);
  }

  private applyChanges(before: RoomInternals, after: RoomInternals): void {
    this.presence.applyChanges(before.presence, after.presence);
    this.workspace.applyChanges(before.workspace, after.workspace);
    this.leaseControl.applyChanges(before.leaseControl, after.leaseControl);
  }
}

function digestRoomToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

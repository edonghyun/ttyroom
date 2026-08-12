import type { LeaseView, RoomSnapshot, TerminalMeta, TerminalView } from "@ttyroom/protocol";

// 스펙 불변식: exclusive 터미널 유효 임대 최대 1·선착순·1인 1임대(새 획득 시 기존 자동 해제)·재도착 멱등
export type AcquireDecision =
  | { kind: "granted"; lease: LeaseView; autoReleased: LeaseView | null }
  | { kind: "already-held"; lease: LeaseView }
  | { kind: "denied"; holderClientId: string }
  | { kind: "rejected"; reason: "terminal-not-open" | "shared-terminal" };

export type ReleaseDecision = { kind: "released"; lease: LeaseView } | { kind: "not-holder" };

export const DEFAULT_ROOM_NAME = "Quick Room";

export class Room {
  readonly roomId: string;
  readonly token: string;
  readonly name: string;
  private readonly participants = new Map<string, { name: string }>();
  private readonly hosts = new Map<
    string,
    { name: string; online: boolean; remoteInputAllowed: boolean }
  >();
  private readonly terminals = new Map<number, TerminalView>();
  private readonly leases = new Map<number, LeaseView>();
  private nextTerminalId = 1;
  private nextLeaseId = 1;

  constructor(options: { roomId: string; token: string; name?: string }) {
    this.roomId = options.roomId;
    this.token = options.token;
    this.name = options.name ?? DEFAULT_ROOM_NAME;
  }

  addParticipant(clientId: string, name: string): void {
    this.participants.set(clientId, { name });
  }

  hasParticipant(clientId: string): boolean {
    return this.participants.has(clientId);
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
  }

  updateTerminalMeta(terminalId: number, meta: TerminalMeta): void {
    this.requireTerminal(terminalId).meta = { ...meta };
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
      participants: [...this.participants].map(([clientId, p]) => ({ clientId, name: p.name })),
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
}

// 구조 복사 — Room 밖으로 나가는 터미널 뷰가 내부 상태로의 역참조를 갖지 않게 차단
function copyOfTerminal(view: TerminalView): TerminalView {
  return { ...view, meta: { ...view.meta } };
}

import { applyMapChanges, copyMap, restoreMap } from "./map-state.js";

export class TerminalIdsExhausted extends Error {}

export interface TerminalMetadata {
  cwd: string | null;
  gitBranch: string | null;
  fgProcess: string | null;
}

export interface TerminalGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HostState {
  hostId: string;
  name: string;
  online: boolean;
  remoteInputAllowed: boolean;
}

export interface TerminalState {
  terminalId: number;
  hostId: string;
  title: string;
  geometry: TerminalGeometry;
  mode: "exclusive" | "shared";
  status: "open" | "exited";
  exitCode: number | null;
  meta: TerminalMetadata;
}

export interface HostTerminalInventoryItem {
  terminalId: number;
  runtimeId: string;
}

export interface HostTerminalReconciliation {
  activeTerminalIds: number[];
  closedTerminalIds: number[];
  connectorTerminalIdsToClose: number[];
  recoveredTerminals: TerminalState[];
}

export interface TerminalWorkspaceRecord {
  nextTerminalId: number;
  hosts: Array<{ hostId: string; name: string }>;
  terminals: Array<{ view: TerminalState; runtimeId: string | null }>;
}

interface HostRuntimeState {
  name: string;
  online: boolean;
  remoteInputAllowed: boolean;
}

export interface TerminalWorkspaceState {
  hosts: Map<string, HostRuntimeState>;
  terminals: Map<number, TerminalState>;
  runtimeIdByTerminal: Map<number, string>;
  nextTerminalId: number;
}

/** Owns hosts and terminal lifecycle, layout, metadata, and connector reconciliation. */
export class TerminalWorkspace {
  private readonly hosts = new Map<string, HostRuntimeState>();
  private readonly terminals = new Map<number, TerminalState>();
  private readonly runtimeIdByTerminal = new Map<number, string>();
  private nextTerminalId = 1;

  restoreRecord(record: TerminalWorkspaceRecord): void {
    this.nextTerminalId = record.nextTerminalId;
    this.hosts.clear();
    for (const host of record.hosts) {
      this.hosts.set(host.hostId, {
        name: host.name,
        online: false,
        remoteInputAllowed: false,
      });
    }
    this.terminals.clear();
    this.runtimeIdByTerminal.clear();
    for (const terminal of record.terminals) {
      this.terminals.set(terminal.view.terminalId, copyOfTerminal(terminal.view));
      if (terminal.runtimeId !== null) {
        this.runtimeIdByTerminal.set(terminal.view.terminalId, terminal.runtimeId);
      }
    }
  }

  record(): TerminalWorkspaceRecord {
    return {
      nextTerminalId: this.nextTerminalId,
      hosts: [...this.hosts].map(([hostId, host]) => ({ hostId, name: host.name })),
      terminals: [...this.terminals.values()].map((view) => ({
        view: copyOfTerminal(view),
        runtimeId: this.runtimeIdByTerminal.get(view.terminalId) ?? null,
      })),
    };
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

  openTerminal(hostId: string): TerminalState {
    if (!this.hosts.has(hostId)) {
      throw new Error(`등록되지 않은 host에 터미널을 열 수 없다: ${hostId}`);
    }

    if (this.nextTerminalId > 0xffffffff)
      throw new TerminalIdsExhausted("Terminal ID space exhausted");
    const terminalId = this.nextTerminalId;
    this.nextTerminalId += 1;
    const view: TerminalState = {
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
      if (terminal.hostId !== hostId) continue;
      this.terminals.delete(terminalId);
      this.runtimeIdByTerminal.delete(terminalId);
      removed.push(terminalId);
    }
    return removed;
  }

  setTerminalMode(terminalId: number, mode: "exclusive" | "shared"): boolean {
    const terminal = this.requireTerminal(terminalId);
    if (terminal.mode === mode) return false;
    terminal.mode = mode;
    return true;
  }

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
    const connectorTerminalIdsToClose = new Set<number>();
    const recoveredTerminals: TerminalState[] = [];

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
      if (item) connectorTerminalIdsToClose.add(terminal.terminalId);
      reported.delete(terminal.terminalId);
    }

    for (const item of reported.values()) {
      if (this.terminals.has(item.terminalId)) {
        connectorTerminalIdsToClose.add(item.terminalId);
        continue;
      }
      const view: TerminalState = {
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
      connectorTerminalIdsToClose: [...connectorTerminalIdsToClose],
      recoveredTerminals,
    };
  }

  updateTerminalMeta(terminalId: number, meta: TerminalMetadata): void {
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

  hasTerminal(terminalId: number): boolean {
    return this.terminals.has(terminalId);
  }

  terminal(terminalId: number): TerminalState | undefined {
    const terminal = this.terminals.get(terminalId);
    return terminal && copyOfTerminal(terminal);
  }

  inputMode(terminalId: number): "exclusive" | "shared" | null {
    const terminal = this.terminals.get(terminalId);
    return terminal?.status === "open" ? terminal.mode : null;
  }

  hasOnlineHost(): boolean {
    return [...this.hosts.values()].some((host) => host.online);
  }

  hostSnapshot(): HostState[] {
    return [...this.hosts].map(([hostId, host]) => ({ hostId, ...host }));
  }

  terminalSnapshot(): TerminalState[] {
    return [...this.terminals.values()].map(copyOfTerminal);
  }

  captureState(): TerminalWorkspaceState {
    return {
      hosts: copyMap(this.hosts, (host) => ({ ...host })),
      terminals: copyMap(this.terminals, copyOfTerminal),
      runtimeIdByTerminal: new Map(this.runtimeIdByTerminal),
      nextTerminalId: this.nextTerminalId,
    };
  }

  restoreState(state: TerminalWorkspaceState): void {
    restoreMap(
      this.hosts,
      copyMap(state.hosts, (host) => ({ ...host })),
    );
    restoreMap(this.terminals, copyMap(state.terminals, copyOfTerminal));
    restoreMap(this.runtimeIdByTerminal, new Map(state.runtimeIdByTerminal));
    this.nextTerminalId = state.nextTerminalId;
  }

  applyChanges(before: TerminalWorkspaceState, after: TerminalWorkspaceState): void {
    applyMapChanges(this.hosts, before.hosts, after.hosts, (host) => ({ ...host }));
    applyMapChanges(this.terminals, before.terminals, after.terminals, copyOfTerminal);
    applyMapChanges(
      this.runtimeIdByTerminal,
      before.runtimeIdByTerminal,
      after.runtimeIdByTerminal,
      (runtimeId) => runtimeId,
    );
    if (before.nextTerminalId !== after.nextTerminalId) {
      this.nextTerminalId = after.nextTerminalId;
    }
  }

  private requireTerminal(terminalId: number): TerminalState {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`존재하지 않는 터미널: ${terminalId}`);
    return terminal;
  }
}

function copyOfTerminal(view: TerminalState): TerminalState {
  return { ...view, geometry: { ...view.geometry }, meta: { ...view.meta } };
}

function initialTerminalGeometry(terminalId: number): TerminalGeometry {
  // Recovered IDs span u32, while protocol workspace coordinates stop at u16 max.
  const position = Math.min(0xffff, 24 + (terminalId - 1) * 32);
  return { x: position, y: position, width: 640, height: 420 };
}

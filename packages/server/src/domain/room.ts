import type { RoomSnapshot, TerminalMeta, TerminalView } from "@ttyroom/protocol";

export class Room {
  readonly roomId: string;
  readonly token: string;
  private readonly participants = new Map<string, { name: string }>();
  private readonly hosts = new Map<string, { name: string; online: boolean }>();
  private readonly terminals = new Map<number, TerminalView>();
  private nextTerminalId = 1;

  constructor(options: { roomId: string; token: string }) {
    this.roomId = options.roomId;
    this.token = options.token;
  }

  addParticipant(clientId: string, name: string): void {
    this.participants.set(clientId, { name });
  }

  hasParticipant(clientId: string): boolean {
    return this.participants.has(clientId);
  }

  removeParticipant(clientId: string): void {
    this.participants.delete(clientId);
  }

  connectHost(hostId: string, name: string): void {
    this.hosts.set(hostId, { name, online: true });
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
    return view;
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
        removed.push(terminalId);
      }
    }
    return removed;
  }

  setTerminalMode(terminalId: number, mode: "exclusive" | "shared"): void {
    this.requireTerminal(terminalId).mode = mode;
  }

  markTerminalExited(terminalId: number, exitCode: number | null): void {
    const terminal = this.requireTerminal(terminalId);
    terminal.status = "exited";
    terminal.exitCode = exitCode;
  }

  updateTerminalMeta(terminalId: number, meta: TerminalMeta): void {
    this.requireTerminal(terminalId).meta = { ...meta };
  }

  terminal(terminalId: number): TerminalView | undefined {
    return this.terminals.get(terminalId);
  }

  private requireTerminal(terminalId: number): TerminalView {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`존재하지 않는 터미널: ${terminalId}`);
    return terminal;
  }

  isEmpty(): boolean {
    const onlineHosts = [...this.hosts.values()].filter((h) => h.online);
    return this.participants.size === 0 && onlineHosts.length === 0;
  }

  snapshot(): RoomSnapshot {
    return {
      roomId: this.roomId,
      participants: [...this.participants].map(([clientId, p]) => ({ clientId, name: p.name })),
      hosts: [...this.hosts].map(([hostId, h]) => ({ hostId, name: h.name, online: h.online })),
      // 구조 복사 — 스냅샷 소비자가 내부 터미널 상태를 변경하지 못하게 차단
      terminals: [...this.terminals.values()].map((t) => ({ ...t, meta: { ...t.meta } })),
      leases: [],
    };
  }
}

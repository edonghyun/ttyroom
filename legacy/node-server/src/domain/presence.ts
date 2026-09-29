import { applyMapChanges, copyMap, restoreMap } from "./map-state.js";

export interface ParticipantState {
  clientId: string;
  name: string;
  focusedTerminalId: number | null;
}

interface ParticipantPresence {
  name: string;
  focusedTerminalId: number | null;
}

export interface PresenceState {
  participants: Map<string, ParticipantPresence>;
}

/** Owns the live participant roster and each participant's current focus. */
export class Presence {
  private readonly participants = new Map<string, ParticipantPresence>();

  add(clientId: string, name: string): void {
    const current = this.participants.get(clientId);
    this.participants.set(clientId, {
      name,
      focusedTerminalId: current?.focusedTerminalId ?? null,
    });
  }

  has(clientId: string): boolean {
    return this.participants.has(clientId);
  }

  focus(clientId: string, terminalId: number | null): "changed" | "unchanged" {
    const participant = this.participants.get(clientId);
    if (!participant) throw new Error(`참여자가 아닌 clientId의 focus 보고: ${clientId}`);
    if (participant.focusedTerminalId === terminalId) return "unchanged";

    participant.focusedTerminalId = terminalId;
    return "changed";
  }

  remove(clientId: string): void {
    this.participants.delete(clientId);
  }

  isEmpty(): boolean {
    return this.participants.size === 0;
  }

  snapshot(): ParticipantState[] {
    return [...this.participants].map(([clientId, participant]) => ({
      clientId,
      name: participant.name,
      focusedTerminalId: participant.focusedTerminalId,
    }));
  }

  captureState(): PresenceState {
    return { participants: copyMap(this.participants, (participant) => ({ ...participant })) };
  }

  restoreState(state: PresenceState): void {
    restoreMap(
      this.participants,
      copyMap(state.participants, (participant) => ({ ...participant })),
    );
  }

  applyChanges(before: PresenceState, after: PresenceState): void {
    applyMapChanges(this.participants, before.participants, after.participants, (participant) => ({
      ...participant,
    }));
  }
}

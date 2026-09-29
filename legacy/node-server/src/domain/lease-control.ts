import { applyMapChanges, copyMap, restoreMap } from "./map-state.js";

export interface Lease {
  terminalId: number;
  leaseId: number;
  holderClientId: string;
}

export type LeaseAcquireDecision =
  | { kind: "granted"; lease: Lease; autoReleased: Lease | null }
  | { kind: "already-held"; lease: Lease }
  | { kind: "denied"; holderClientId: string };

export type ReleaseDecision = { kind: "released"; lease: Lease } | { kind: "not-holder" };

export interface LeaseControlState {
  leases: Map<number, Lease>;
  nextLeaseId: number;
}

/** Owns exclusive terminal leases, including idempotency and one-lease-per-participant. */
export class LeaseControl {
  private readonly leases = new Map<number, Lease>();
  private nextLeaseId = 1;

  acquire(clientId: string, terminalId: number): LeaseAcquireDecision {
    const existing = this.leases.get(terminalId);
    if (existing) {
      if (existing.holderClientId === clientId) {
        return { kind: "already-held", lease: { ...existing } };
      }
      return { kind: "denied", holderClientId: existing.holderClientId };
    }

    const autoReleased = this.releaseAllOf(clientId)[0] ?? null;
    const lease: Lease = { terminalId, leaseId: this.nextLeaseId, holderClientId: clientId };
    this.nextLeaseId += 1;
    this.leases.set(terminalId, lease);
    return { kind: "granted", lease: { ...lease }, autoReleased };
  }

  releaseAllOf(clientId: string): Lease[] {
    const released: Lease[] = [];
    for (const [terminalId, lease] of this.leases) {
      if (lease.holderClientId === clientId) {
        this.leases.delete(terminalId);
        released.push({ ...lease });
      }
    }
    return released;
  }

  release(clientId: string, terminalId: number): ReleaseDecision {
    const lease = this.leases.get(terminalId);
    if (!lease || lease.holderClientId !== clientId) return { kind: "not-holder" };

    this.leases.delete(terminalId);
    return { kind: "released", lease: { ...lease } };
  }

  removeTerminals(terminalIds: readonly number[]): void {
    for (const terminalId of terminalIds) this.leases.delete(terminalId);
  }

  leaseOf(terminalId: number): Lease | undefined {
    const lease = this.leases.get(terminalId);
    return lease && { ...lease };
  }

  isHeldBy(clientId: string, terminalId: number, leaseId: number): boolean {
    const lease = this.leases.get(terminalId);
    return !!lease && lease.holderClientId === clientId && lease.leaseId === leaseId;
  }

  snapshot(): Lease[] {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  captureState(): LeaseControlState {
    return {
      leases: copyMap(this.leases, (lease) => ({ ...lease })),
      nextLeaseId: this.nextLeaseId,
    };
  }

  restoreState(state: LeaseControlState): void {
    restoreMap(
      this.leases,
      copyMap(state.leases, (lease) => ({ ...lease })),
    );
    this.nextLeaseId = state.nextLeaseId;
  }

  applyChanges(before: LeaseControlState, after: LeaseControlState): void {
    applyMapChanges(this.leases, before.leases, after.leases, (lease) => ({ ...lease }));
    if (before.nextLeaseId !== after.nextLeaseId) this.nextLeaseId = after.nextLeaseId;
  }
}

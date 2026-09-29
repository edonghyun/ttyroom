package dev.ttyroom.domain;

import java.util.LinkedHashMap;
import java.util.List;

/** Owns exclusive leases and one-lease-per-participant. The room owner serializes mutations. */
public final class LeaseControl {
    public record Lease(long terminalId, long leaseId, String holderClientId) {}

    public sealed interface Acquisition {
        record Acquired(Lease lease, Lease released) implements Acquisition {}

        record AlreadyHeld(Lease lease) implements Acquisition {}

        record Denied(String holderClientId) implements Acquisition {}
    }

    public static final class IdsExhausted extends RuntimeException {}

    private final LinkedHashMap<Long, Lease> leases = new LinkedHashMap<>();
    private long nextLeaseId = 1;

    LeaseControl copy() {
        var copy = new LeaseControl();
        copy.leases.putAll(leases);
        copy.nextLeaseId = nextLeaseId;
        return copy;
    }

    /** Caller validates that the terminal is open and exclusive before acquiring. */
    public Acquisition acquire(String participantId, long terminalId) {
        var existing = leases.get(terminalId);
        if (existing != null) {
            return existing.holderClientId().equals(participantId)
                    ? new Acquisition.AlreadyHeld(existing)
                    : new Acquisition.Denied(existing.holderClientId());
        }
        if (nextLeaseId > 0xffff_ffffL) throw new IdsExhausted();
        var released = releaseAllOf(participantId);
        var lease = new Lease(terminalId, nextLeaseId++, participantId);
        leases.put(terminalId, lease);
        return new Acquisition.Acquired(lease, released.isEmpty() ? null : released.getFirst());
    }

    public boolean isHeldBy(String participantId, long terminalId, long leaseId) {
        var lease = leases.get(terminalId);
        return lease != null
                && lease.holderClientId().equals(participantId)
                && lease.leaseId() == leaseId;
    }

    public boolean release(String participantId, long terminalId, long leaseId) {
        if (!isHeldBy(participantId, terminalId, leaseId)) return false;
        leases.remove(terminalId);
        return true;
    }

    public List<Lease> releaseAllOf(String participantId) {
        var released =
                leases.values().stream()
                        .filter(lease -> lease.holderClientId().equals(participantId))
                        .toList();
        released.forEach(lease -> leases.remove(lease.terminalId()));
        return released;
    }

    public void removeTerminals(List<Long> terminalIds) {
        terminalIds.forEach(leases::remove);
    }

    public List<Lease> snapshot() {
        return List.copyOf(leases.values());
    }
}

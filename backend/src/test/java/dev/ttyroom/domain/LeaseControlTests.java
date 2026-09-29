package dev.ttyroom.domain;

import static org.assertj.core.api.Assertions.assertThat;

import dev.ttyroom.domain.LeaseControl.*;

import org.junit.jupiter.api.Test;

import java.util.List;

class LeaseControlTests {
    @Test
    void reacquisitionAndDeniedRequestsLeaveIdsAndOtherLeasesUnchanged() {
        var leases = new LeaseControl();
        leases.acquire("alice", 7);
        leases.acquire("bob", 8);
        var before = leases.snapshot();

        var denied = leases.acquire("bob", 7);
        var repeated = leases.acquire("alice", 7);
        var afterRejected = leases.snapshot();
        var moved = leases.acquire("alice", 9);

        assertThat(denied).isEqualTo(new Acquisition.Denied("alice"));
        assertThat(repeated).isEqualTo(new Acquisition.AlreadyHeld(new Lease(7, 1, "alice")));
        assertThat(afterRejected).isEqualTo(before);
        assertThat(moved)
                .isEqualTo(
                        new Acquisition.Acquired(
                                new Lease(9, 3, "alice"), new Lease(7, 1, "alice")));
        assertThat(leases.snapshot())
                .containsExactly(new Lease(8, 2, "bob"), new Lease(9, 3, "alice"));
    }

    @Test
    void staleReleaseCannotReleaseTheNewAcquisitionEvenForTheSameHolder() {
        var leases = new LeaseControl();
        leases.acquire("alice", 7);
        leases.release("alice", 7, 1);
        leases.acquire("alice", 7);

        var stale = leases.release("alice", 7, 1);
        var foreign = leases.release("bob", 7, 2);
        var current = leases.isHeldBy("alice", 7, 2);

        assertThat(stale).isFalse();
        assertThat(foreign).isFalse();
        assertThat(current).isTrue();
        assertThat(leases.snapshot()).containsExactly(new Lease(7, 2, "alice"));
    }

    @Test
    void participantAndTerminalRemovalCleanOnlyTheirLeasesWithoutReusingIds() {
        var leases = new LeaseControl();
        leases.acquire("alice", 7);
        leases.acquire("bob", 8);
        leases.acquire("carol", 9);
        var before = leases.snapshot();

        var released = leases.releaseAllOf("alice");
        leases.removeTerminals(List.of(8L));
        var next = leases.acquire("dan", 7);

        assertThat(released).containsExactly(new Lease(7, 1, "alice"));
        assertThat(before).hasSize(3);
        assertThat(next).isEqualTo(new Acquisition.Acquired(new Lease(7, 4, "dan"), null));
        assertThat(leases.snapshot())
                .containsExactly(new Lease(9, 3, "carol"), new Lease(7, 4, "dan"));
    }
}

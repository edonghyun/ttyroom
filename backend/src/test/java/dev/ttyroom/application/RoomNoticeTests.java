package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;

import dev.ttyroom.application.RoomNotice.*;
import dev.ttyroom.domain.HostPresence;
import dev.ttyroom.domain.LeaseControl;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

class RoomNoticeTests {
    @Test
    void aWelcomeKeepsItsMembershipSnapshotAfterTheSourceListsChange() {
        var alice = new Participant("alice", "Alice", null);
        var participants = new ArrayList<>(List.of(alice));
        var hosts = new ArrayList<HostPresence.State>();
        var leases = new ArrayList<LeaseControl.Lease>();
        var welcome = new Welcome("room", "Test", "alice", participants, hosts, List.of(), leases);

        participants.clear();
        leases.add(new LeaseControl.Lease(7, 1, "alice"));
        hosts.add(new HostPresence.State("host", "Host", false, false));

        assertThat(welcome.participants()).containsExactly(alice);
        assertThat(welcome.hosts()).isEmpty();
        assertThat(welcome.leases()).isEmpty();
    }
}

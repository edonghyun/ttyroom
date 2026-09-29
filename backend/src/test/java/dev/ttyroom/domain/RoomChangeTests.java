package dev.ttyroom.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class RoomChangeTests {
    @Test
    void draftDoesNotExposeItsReservationOrConsumeAnIdUntilCommit() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        var discarded = room.stageChange(draft -> draft.openTerminal("host"));
        var before = room.terminals();

        var accepted = room.stageChange(draft -> draft.openTerminal("host"));
        accepted.commit();
        var next = room.openTerminal("host");

        assertThat(before).isEmpty();
        assertThat(discarded.result().terminalId()).isEqualTo(1);
        assertThat(accepted.result().terminalId()).isEqualTo(1);
        assertThat(accepted.recordToSave()).isNotNull();
        assertThat(next.terminalId()).isEqualTo(2);
    }

    @Test
    void stagingPreservesLiveLeaseIdsAndExplicitOpeningHistory() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        var terminal = room.openTerminal("host");
        room.confirmTerminalOpened("host", terminal.terminalId(), "runtime");
        room.acquireLease("alice", terminal.terminalId());
        room.acquireLease("bob", room.openTerminal("host").terminalId());
        var leases = room.leases();

        var change = room.stageChange(draft -> draft.renameTerminal(1, "Renamed"));
        change.commit();
        var confirmation = room.confirmTerminalOpened("host", 1, "runtime");
        var preserved = room.leases();
        room.acquireLease("charlie", room.openTerminal("host").terminalId());

        assertThat(preserved).isEqualTo(leases);
        assertThat(confirmation).isEmpty();
        assertThat(room.leases().getLast().leaseId()).isEqualTo(3);
    }

    @Test
    void liveOnlyAndSameValueChangesCommitWithoutAStorageRecord() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        var terminal = room.openTerminal("host");

        var lease = room.stageChange(draft -> draft.acquireLease("alice", 1));
        lease.commit();
        var geometry =
                room.stageChange(draft -> draft.updateTerminalGeometry(1, terminal.geometry()));
        geometry.commit();

        assertThat(lease.recordToSave()).isNull();
        assertThat(geometry.recordToSave()).isNull();
        assertThat(geometry.result()).isTrue();
        assertThat(room.leases()).containsExactly(new LeaseControl.Lease(1, 1, "alice"));
    }
}

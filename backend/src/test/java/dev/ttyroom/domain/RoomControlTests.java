package dev.ttyroom.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.ttyroom.domain.RoomControl.InputHost;
import dev.ttyroom.domain.RoomControl.InputRejection;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.List;
import java.util.stream.Stream;

class RoomControlTests {
    @Test
    void missingTerminalCannotDisplaceTheParticipantsExistingLease() {
        var given = controlledTerminal();
        var before = given.room.leases();

        assertThatThrownBy(() -> given.room.acquireLease("alice", 99))
                .isInstanceOf(RoomControl.TerminalUnavailable.class);
        assertThat(given.room.leases()).isEqualTo(before);
    }

    @Test
    void exitedTerminalCannotDisplaceTheParticipantsExistingLease() {
        var given = controlledTerminal();
        var exited = given.room.openTerminal("host").terminalId();
        given.room.terminalExited("host", exited, 0.0);
        var before = given.room.leases();

        assertThatThrownBy(() -> given.room.acquireLease("alice", exited))
                .isInstanceOf(RoomControl.TerminalUnavailable.class);
        assertThat(given.room.leases()).isEqualTo(before);
    }

    @Test
    void reservationCanBeControlledBeforeRuntimeConfirmation() {
        var given = controlledTerminal();

        var rejection =
                given.room.inputRejection(
                        "alice",
                        given.terminalId,
                        given.leaseId,
                        new InputHost("host", true, true));

        assertThat(rejection).isEmpty();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("rejectedInputs")
    void rejectsInputWithoutChangingTheLease(
            String scenario,
            String participantId,
            long leaseId,
            InputHost host,
            InputRejection expected) {
        var given = controlledTerminal();
        var before = given.room.leases();

        var rejection = given.room.inputRejection(participantId, given.terminalId, leaseId, host);

        assertThat(rejection).contains(expected);
        assertThat(given.room.leases()).isEqualTo(before);
    }

    static Stream<Arguments> rejectedInputs() {
        return Stream.of(
                Arguments.of(
                        "absent host before ownership",
                        "bob",
                        99L,
                        null,
                        InputRejection.TERMINAL_CLOSED),
                Arguments.of(
                        "disconnected host before permission",
                        "bob",
                        99L,
                        new InputHost("host", false, false),
                        InputRejection.TERMINAL_CLOSED),
                Arguments.of(
                        "permission before ownership",
                        "bob",
                        99L,
                        new InputHost("host", true, false),
                        InputRejection.REMOTE_INPUT_DISABLED),
                Arguments.of(
                        "another holder",
                        "bob",
                        1L,
                        new InputHost("host", true, true),
                        InputRejection.NOT_HOLDER),
                Arguments.of(
                        "stale lease",
                        "alice",
                        99L,
                        new InputHost("host", true, true),
                        InputRejection.NOT_HOLDER),
                Arguments.of(
                        "another hosts permission is not authority",
                        "alice",
                        1L,
                        new InputHost("other-host", true, true),
                        InputRejection.TERMINAL_CLOSED));
    }

    @Test
    void missingTerminalIsRejectedBeforeHostPermission() {
        var room = new RoomControl();

        var rejection = room.inputRejection("alice", 99, 1, new InputHost("host", true, false));

        assertThat(rejection).contains(InputRejection.TERMINAL_CLOSED);
    }

    @Test
    void exitRetainsTheLeaseButBlocksInputBeforeHostPermission() {
        var given = controlledTerminal();
        var before = given.room.leases();

        given.room.terminalExited("host", given.terminalId, 0.0);
        var rejection =
                given.room.inputRejection(
                        "alice",
                        given.terminalId,
                        given.leaseId,
                        new InputHost("host", true, false));

        assertThat(rejection).contains(InputRejection.TERMINAL_CLOSED);
        assertThat(given.room.leases()).isEqualTo(before);
    }

    @Test
    void inventoryLossRetainsTheLeaseButBlocksInput() {
        var given = controlledTerminal();
        var before = given.room.leases();

        given.room.reconcileTerminals("host", List.of());
        var rejection =
                given.room.inputRejection(
                        "alice",
                        given.terminalId,
                        given.leaseId,
                        new InputHost("host", true, true));

        assertThat(rejection).contains(InputRejection.TERMINAL_CLOSED);
        assertThat(given.room.leases()).isEqualTo(before);
    }

    @Test
    void removingHostRemovesItsOpenAndExitedTerminalsAndLeasesTogether() {
        var given = controlledTerminal();
        var exited = given.room.openTerminal("host").terminalId();
        given.room.acquireLease("bob", exited);
        given.room.terminalExited("host", exited, 0.0);
        given.room.rememberHost("other-host", "Other laptop");
        var other = given.room.openTerminal("other-host");
        var otherLease = acquire(given.room, "carol", other.terminalId());
        var before = given.room.leases();

        var removed = given.room.removeHost("host");

        assertThat(removed).containsExactly(given.terminalId, exited);
        assertThat(given.room.terminals()).containsExactly(other);
        assertThat(given.room.leases()).containsExactly(otherLease);
        assertThat(before).hasSize(3);
    }

    @Test
    void removingParticipantReleasesOnlyTheirLeaseAndPreservesTerminals() {
        var given = controlledTerminal();
        var other = given.room.openTerminal("host").terminalId();
        var otherLease = acquire(given.room, "bob", other);
        var terminals = given.room.terminals();
        var aliceLease = given.room.leases().getFirst();

        var released = given.room.removeParticipant("alice");

        assertThat(released).containsExactly(aliceLease);
        assertThat(given.room.leases()).containsExactly(otherLease);
        assertThat(given.room.terminals()).isEqualTo(terminals);
    }

    @Test
    void modeRoundTripRetainsTheLeaseAndRestoresExclusiveAuthorization() {
        var given = controlledTerminal();
        var before = given.room.terminals();
        var leases = given.room.leases();
        var host = new InputHost("host", true, true);

        var shared =
                given.room.setTerminalMode(given.terminalId, TerminalWorkspace.Mode.SHARED, "host");
        var guestInput = given.room.inputRejection("bob", given.terminalId, 0, host);
        var sharedView = given.room.terminals();
        var exclusive =
                given.room.setTerminalMode(
                        given.terminalId, TerminalWorkspace.Mode.EXCLUSIVE, "host");
        var denied = given.room.inputRejection("bob", given.terminalId, given.leaseId, host);
        var holderInput = given.room.inputRejection("alice", given.terminalId, given.leaseId, host);

        assertThat(shared).isEqualTo(new RoomControl.ModeChange.Changed());
        assertThat(exclusive).isEqualTo(new RoomControl.ModeChange.Changed());
        assertThat(guestInput).isEmpty();
        assertThat(denied).contains(InputRejection.NOT_HOLDER);
        assertThat(holderInput).isEmpty();
        assertThat(sharedView.getFirst().mode()).isEqualTo(TerminalWorkspace.Mode.SHARED);
        assertThat(given.room.terminals()).isEqualTo(before);
        assertThat(given.room.leases()).isEqualTo(leases);
    }

    @Test
    void sameModeIsUnchangedButStillRequiresACurrentHost() {
        var given = controlledTerminal();

        var unchanged =
                given.room.setTerminalMode(
                        given.terminalId, TerminalWorkspace.Mode.EXCLUSIVE, "host");
        var offline =
                given.room.setTerminalMode(
                        given.terminalId, TerminalWorkspace.Mode.EXCLUSIVE, null);
        var wrongHost =
                given.room.setTerminalMode(
                        given.terminalId, TerminalWorkspace.Mode.SHARED, "other");

        assertThat(unchanged).isEqualTo(new RoomControl.ModeChange.Unchanged());
        assertThat(offline)
                .isEqualTo(
                        new RoomControl.ModeChange.Rejected(
                                RoomControl.TerminalRejection.HOST_OFFLINE));
        assertThat(wrongHost).isEqualTo(offline);
        assertThat(given.room.terminals().getFirst().mode())
                .isEqualTo(TerminalWorkspace.Mode.EXCLUSIVE);
    }

    @Test
    void missingAndExitedTerminalsAreRejectedBeforeHostAvailability() {
        var given = controlledTerminal();
        given.room.terminalExited("host", given.terminalId, 7.0);
        var before = given.room.terminals();
        var leases = given.room.leases();

        var missing = given.room.setTerminalMode(99, TerminalWorkspace.Mode.SHARED, null);
        var exited =
                given.room.setTerminalMode(given.terminalId, TerminalWorkspace.Mode.SHARED, null);

        assertThat(missing)
                .isEqualTo(
                        new RoomControl.ModeChange.Rejected(
                                RoomControl.TerminalRejection.TERMINAL_NOT_FOUND));
        assertThat(exited)
                .isEqualTo(
                        new RoomControl.ModeChange.Rejected(
                                RoomControl.TerminalRejection.TERMINAL_NOT_OPEN));
        assertThat(given.room.terminals()).isEqualTo(before);
        assertThat(given.room.leases()).isEqualTo(leases);
    }

    @Test
    void sharedModeCannotBypassConnectionPermissionOrExitChecks() {
        var given = controlledTerminal();
        given.room.setTerminalMode(given.terminalId, TerminalWorkspace.Mode.SHARED, "host");

        var disconnected =
                given.room.inputRejection(
                        "bob", given.terminalId, 0, new InputHost("host", false, true));
        var disabled =
                given.room.inputRejection(
                        "bob", given.terminalId, 0, new InputHost("host", true, false));
        given.room.terminalExited("host", given.terminalId, 0.0);
        var exited =
                given.room.inputRejection(
                        "bob", given.terminalId, 0, new InputHost("host", true, true));

        assertThat(disconnected).contains(InputRejection.TERMINAL_CLOSED);
        assertThat(disabled).contains(InputRejection.REMOTE_INPUT_DISABLED);
        assertThat(exited).contains(InputRejection.TERMINAL_CLOSED);
    }

    @Test
    void acquiringSharedTerminalDoesNotDisplaceAnotherLeaseOrConsumeAnId() {
        var given = controlledTerminal();
        given.room.setTerminalMode(given.terminalId, TerminalWorkspace.Mode.SHARED, "host");
        var other = given.room.openTerminal("host").terminalId();
        var bobLease = acquire(given.room, "bob", other);
        var before = given.room.leases();

        var failure =
                org.assertj.core.api.Assertions.catchThrowable(
                        () -> given.room.acquireLease("bob", given.terminalId));
        var afterRejected = given.room.leases();
        var next = given.room.openTerminal("host").terminalId();
        var moved = acquire(given.room, "bob", next);

        assertThat(failure).isInstanceOf(RoomControl.TerminalUnavailable.class);
        assertThat(afterRejected).isEqualTo(before);
        assertThat(moved.leaseId()).isEqualTo(bobLease.leaseId() + 1);
    }

    @Test
    void inventoryAndMetadataPreserveModeLeaseAndRuntimeIdentity() {
        var given = controlledTerminal();
        given.room.confirmTerminalOpened("host", given.terminalId, "runtime");
        given.room.setTerminalMode(given.terminalId, TerminalWorkspace.Mode.SHARED, "host");
        var before = given.room.terminals();
        var leases = given.room.leases();
        var metadata = new TerminalWorkspace.Metadata("/shared", "main", "sh");

        given.room.updateTerminalMetadata("host", given.terminalId, metadata);
        var reconciliation =
                given.room.reconcileTerminals(
                        "host",
                        List.of(new TerminalWorkspace.Runtime(given.terminalId, "runtime")));

        assertThat(reconciliation.active()).containsExactly(given.terminalId);
        assertThat(given.room.terminals().getFirst().mode())
                .isEqualTo(TerminalWorkspace.Mode.SHARED);
        assertThat(given.room.terminals().getFirst().meta()).isEqualTo(metadata);
        assertThat(before.getFirst().meta())
                .isEqualTo(new TerminalWorkspace.Metadata(null, null, null));
        assertThat(given.room.leases()).isEqualTo(leases);
    }

    @Test
    void terminalControlValidationDoesNotChangeModeLifecycleMetadataOrLease() {
        var given = controlledTerminal();
        given.room.setTerminalMode(given.terminalId, TerminalWorkspace.Mode.SHARED, "host");
        var before = given.room.terminals();
        var leases = given.room.leases();

        var allowed = given.room.terminalRequestRejection(given.terminalId, "host");
        var offline = given.room.terminalRequestRejection(given.terminalId, null);
        var foreign = given.room.terminalRequestRejection(given.terminalId, "other");
        var missing = given.room.terminalRequestRejection(99, null);

        assertThat(allowed).isEmpty();
        assertThat(offline).contains(RoomControl.TerminalRejection.HOST_OFFLINE);
        assertThat(foreign).isEqualTo(offline);
        assertThat(missing).contains(RoomControl.TerminalRejection.TERMINAL_NOT_FOUND);
        assertThat(given.room.terminals()).isEqualTo(before);
        assertThat(given.room.leases()).isEqualTo(leases);
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"pending", "running", "exited"})
    void viewEditsPreserveLifecycleMetadataModeLeaseAndEarlierSnapshots(String state) {
        var given = controlledTerminal();
        var room = given.room;
        long id = given.terminalId;
        room.setTerminalMode(id, TerminalWorkspace.Mode.SHARED, "host");
        room.updateTerminalMetadata(
                "host", id, new TerminalWorkspace.Metadata("/work", "main", "sh"));
        if (!state.equals("pending")) room.confirmTerminalOpened("host", id, "runtime");
        if (state.equals("exited")) room.terminalExited("host", id, 9.0);
        var before = room.terminals().getFirst();
        var leases = room.leases();
        var geometry = new TerminalWorkspace.Geometry(-1.5, 25, 0.5, 65535);

        var renamed = room.renameTerminal(id, "API");
        var moved = room.updateTerminalGeometry(id, geometry);
        var after = room.terminals().getFirst();
        var inventory =
                room.reconcileTerminals(
                        "host", List.of(new TerminalWorkspace.Runtime(id, "runtime")));

        assertThat(renamed).isTrue();
        assertThat(moved).isTrue();
        assertThat(after)
                .isEqualTo(
                        new TerminalWorkspace.Terminal(
                                id,
                                "host",
                                "API",
                                geometry,
                                before.mode(),
                                before.status(),
                                before.exitCode(),
                                before.meta()));
        assertThat(before.title()).isEqualTo("term-1");
        assertThat(before.geometry()).isEqualTo(new TerminalWorkspace.Geometry(24, 24, 640, 420));
        assertThat(room.leases()).isEqualTo(leases);
        assertThat(inventory.active()).isEqualTo(state.equals("exited") ? List.of() : List.of(id));
        assertThat(inventory.toClose()).isEqualTo(state.equals("exited") ? List.of(id) : List.of());
    }

    @Test
    void viewEditsDistinguishUnchangedTitleFromRepeatedGeometryAndIgnoreUnknownIds() {
        var given = controlledTerminal();
        var before = given.room.terminals();
        var terminal = before.getFirst();

        var unchanged = given.room.renameTerminal(given.terminalId, terminal.title());
        var repeated = given.room.updateTerminalGeometry(given.terminalId, terminal.geometry());
        var missingTitle = given.room.renameTerminal(99, "missing");
        var missingGeometry = given.room.updateTerminalGeometry(99, terminal.geometry());

        assertThat(unchanged).isFalse();
        assertThat(repeated).isTrue();
        assertThat(missingTitle).isFalse();
        assertThat(missingGeometry).isFalse();
        assertThat(given.room.terminals()).isEqualTo(before);
    }

    private record ControlledTerminal(RoomControl room, long terminalId, long leaseId) {}

    private static ControlledTerminal controlledTerminal() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        var terminalId = room.openTerminal("host").terminalId();
        return new ControlledTerminal(
                room, terminalId, acquire(room, "alice", terminalId).leaseId());
    }

    private static LeaseControl.Lease acquire(
            RoomControl room, String participant, long terminalId) {
        return ((LeaseControl.Acquisition.Acquired) room.acquireLease(participant, terminalId))
                .lease();
    }
}

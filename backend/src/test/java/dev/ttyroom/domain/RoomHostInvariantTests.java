package dev.ttyroom.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.List;
import java.util.stream.Stream;

class RoomHostInvariantTests {
    @Test
    void unknownHostCannotReserveATerminalOrConsumeItsId() {
        var room = new RoomControl();
        var before = room.durableState();

        var failure = catchThrowable(() -> room.openTerminal("missing"));
        var rejected = room.durableState();
        room.rememberHost("missing", "Laptop");
        var first = room.openTerminal("missing");

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
        assertThat(rejected).isEqualTo(before);
        assertThat(first.terminalId()).isEqualTo(1);
    }

    @ParameterizedTest
    @MethodSource("unknownHostInventories")
    void unknownHostInventoryCannotChangeWorkspaceLeaseOrAllocator(
            List<TerminalWorkspace.Runtime> inventory) {
        var room = new RoomControl();
        room.rememberHost("known", "Laptop");
        var first = room.openTerminal("known");
        room.acquireLease("alice", first.terminalId());
        var before = room.durableState();
        var leases = room.leases();

        var failure = catchThrowable(() -> room.reconcileTerminals("missing", inventory));
        var rejected = room.durableState();
        var next = room.openTerminal("known");

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
        assertThat(rejected).isEqualTo(before);
        assertThat(room.leases()).isEqualTo(leases);
        assertThat(next.terminalId()).isEqualTo(2);
    }

    static Stream<List<TerminalWorkspace.Runtime>> unknownHostInventories() {
        return Stream.of(List.of(), List.of(new TerminalWorkspace.Runtime(99, "runtime")));
    }

    @ParameterizedTest(name = "{0}: stored terminal requires a registered host")
    @MethodSource("orphanedTerminalStates")
    void storedStateRejectsTerminalWithoutRegisteredHost(
            String lifecycle, TerminalWorkspace.DurableState workspace) {
        var knownHosts = List.of(new RoomControl.HostIdentity("another", "Other laptop"));

        var failure = catchThrowable(() -> new RoomControl.DurableState(knownHosts, workspace));

        assertThat(failure)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Terminal host is not registered");
    }

    static Stream<Arguments> orphanedTerminalStates() {
        var workspace = new TerminalWorkspace();
        var terminal = workspace.open("missing");
        var pending = workspace.durableState();
        workspace.confirmOpened("missing", terminal.terminalId(), "runtime");
        var running = workspace.durableState();
        workspace.markExited("missing", terminal.terminalId(), 0.0);
        var exited = workspace.durableState();
        return Stream.of(
                Arguments.of("pending", pending),
                Arguments.of("running", running),
                Arguments.of("exited", exited));
    }
}

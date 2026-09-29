package dev.ttyroom.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import dev.ttyroom.domain.TerminalWorkspace.*;
import dev.ttyroom.domain.TerminalWorkspace.Runtime;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

class DurableRoomControlTests {
    @Test
    void restoresViewsAndHostIdentityButStartsWithFreshLeases() {
        var room = workspaceWithEveryLifecycle();
        var saved = room.durableState();

        var restored = RoomControl.restore(saved);
        var initialLeases = restored.leases();
        var acquired = restored.acquireLease("bob", 1);

        assertThat(restored.durableState()).isEqualTo(saved);
        assertThat(restored.terminals()).isEqualTo(room.terminals());
        assertThat(restored.hosts())
                .containsExactly(new RoomControl.HostIdentity("host", "Laptop"));
        assertThat(initialLeases).isEmpty();
        assertThat(acquired)
                .isEqualTo(
                        new LeaseControl.Acquisition.Acquired(
                                new LeaseControl.Lease(1, 1, "bob"), null));
    }

    @Test
    void restoredPendingAcceptsItsFirstRuntimeWhileRunningMustMatchAndExitedCannotReopen() {
        var restored = RoomControl.restore(workspaceWithEveryLifecycle().durableState());

        var result =
                restored.reconcileTerminals(
                        "host",
                        List.of(
                                new Runtime(1, "first-runtime"), new Runtime(2, "runtime-2"),
                                new Runtime(3, "replacement"), new Runtime(4, "exited-runtime")));

        var next = restored.openTerminal("host");

        assertThat(result.active()).containsExactly(1L, 2L);
        assertThat(result.closed()).containsExactly(3L);
        assertThat(result.toClose()).containsExactly(3L, 4L);
        assertThat(result.recovered()).isEmpty();
        assertThat(restored.terminal(3).orElseThrow().exitCode()).isNull();
        assertThat(restored.terminal(4).orElseThrow().exitCode()).isEqualTo(9.0);
        assertThat(next.terminalId()).isEqualTo(6);
    }

    @Test
    void missingRuntimeExitsAfterRestoreWithoutReusingItsId() {
        var restored = RoomControl.restore(workspaceWithEveryLifecycle().durableState());

        var result = restored.reconcileTerminals("host", List.of());
        var next = restored.openTerminal("host");

        assertThat(result.closed()).containsExactly(1L, 2L, 3L);
        assertThat(result.toClose()).isEmpty();
        assertThat(restored.terminal(2).orElseThrow().status()).isEqualTo(Status.EXITED);
        assertThat(next.terminalId()).isEqualTo(6);
    }

    @Test
    void removingAllTerminalsDoesNotRewindTheRestoredCounter() {
        var room = workspaceWithEveryLifecycle();
        room.removeHost("host");

        var restored = RoomControl.restore(room.durableState());
        var restoredHosts = restored.hosts();
        restored.rememberHost("another", "Other laptop");
        var next = restored.openTerminal("another");

        assertThat(restoredHosts).isEmpty();
        assertThat(next.terminalId()).isEqualTo(6);
    }

    @Test
    void exhaustedCounterSurvivesEvenWhenItsTerminalWasRemoved() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        room.reconcileTerminals("host", List.of(new Runtime(0xffff_ffffL, "last")));
        room.removeHost("host");

        var restored = RoomControl.restore(room.durableState());
        restored.rememberHost("host", "Laptop");
        var failure = catchThrowable(() -> restored.openTerminal("host"));

        assertThat(restored.terminals()).isEmpty();
        assertThat(failure).isInstanceOf(TerminalWorkspace.IdsExhausted.class);
    }

    @Test
    void durableValuesAndIndependentRestoresCannotMutateEachOther() {
        var room = workspaceWithEveryLifecycle();
        var saved = room.durableState();
        var hosts = new ArrayList<>(saved.hosts());
        var terminals = new ArrayList<>(saved.workspace().terminals());
        var copied =
                new RoomControl.DurableState(
                        hosts,
                        new TerminalWorkspace.DurableState(
                                saved.workspace().nextTerminalId(), terminals));
        var restored = RoomControl.restore(copied);
        var sibling = RoomControl.restore(copied);

        hosts.clear();
        terminals.clear();
        room.removeHost("host");
        restored.renameTerminal(2, "Changed");
        var mutation = catchThrowable(() -> copied.hosts().clear());
        var terminalMutation = catchThrowable(() -> copied.workspace().terminals().clear());

        assertThat(copied).isEqualTo(saved);
        assertThat(sibling.durableState()).isEqualTo(saved);
        assertThat(restored.terminal(2).orElseThrow().title()).isEqualTo("Changed");
        assertThat(mutation).isInstanceOf(UnsupportedOperationException.class);
        assertThat(terminalMutation).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void explicitOpeningConfirmationHistoryIsTransient() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        var terminal = room.openTerminal("host");
        room.confirmTerminalOpened("host", terminal.terminalId(), "runtime");
        var restored = RoomControl.restore(room.durableState());

        var first = restored.confirmTerminalOpened("host", terminal.terminalId(), "runtime");
        var repeated = restored.confirmTerminalOpened("host", terminal.terminalId(), "runtime");

        assertThat(first).contains(terminal);
        assertThat(repeated).isEmpty();
    }

    @Test
    void recoveredZeroIdAlsoSurvivesRestore() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        room.reconcileTerminals("host", List.of(new Runtime(0, "runtime-zero")));

        var restored = RoomControl.restore(room.durableState());
        var result = restored.reconcileTerminals("host", List.of(new Runtime(0, "runtime-zero")));
        var next = restored.openTerminal("host");

        assertThat(result.active()).containsExactly(0L);
        assertThat(next.terminalId()).isEqualTo(1);
    }

    @Test
    void duplicateIdsAndRewoundCountersCannotSilentlyOverwriteRestoredTerminals() {
        var state = workspaceWithEveryLifecycle().durableState().workspace();
        var terminal = state.terminals().getFirst();

        var duplicate =
                catchThrowable(
                        () -> new TerminalWorkspace.DurableState(6, List.of(terminal, terminal)));
        var rewound =
                catchThrowable(() -> new TerminalWorkspace.DurableState(1, List.of(terminal)));
        var zero = catchThrowable(() -> new TerminalWorkspace.DurableState(0, List.of()));
        var overflow =
                catchThrowable(() -> new TerminalWorkspace.DurableState(0x1_0000_0001L, List.of()));

        assertThat(duplicate).isInstanceOf(IllegalArgumentException.class);
        assertThat(rewound).isInstanceOf(IllegalArgumentException.class);
        assertThat(zero).isInstanceOf(IllegalArgumentException.class);
        assertThat(overflow).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void contradictoryLifecycleCannotBeSilentlyNormalizedDuringRestore() {
        var view = workspaceWithEveryLifecycle().terminal(4).orElseThrow();
        var openWithExit =
                new Terminal(
                        view.terminalId(),
                        view.hostId(),
                        view.title(),
                        view.geometry(),
                        view.mode(),
                        Status.OPEN,
                        9.0,
                        view.meta());

        var exitedRuntime = catchThrowable(() -> new StoredTerminal(view, "still-running"));
        var openExit = catchThrowable(() -> new StoredTerminal(openWithExit, null));

        assertThat(exitedRuntime).isInstanceOf(IllegalArgumentException.class);
        assertThat(openExit).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void duplicateHostIdentityCannotSilentlyReplaceItsStoredName() {
        var state = workspaceWithEveryLifecycle().durableState();
        var hosts =
                List.of(
                        new RoomControl.HostIdentity("host", "Laptop"),
                        new RoomControl.HostIdentity("host", "Other"));

        var failure = catchThrowable(() -> new RoomControl.DurableState(hosts, state.workspace()));

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
    }

    private static RoomControl workspaceWithEveryLifecycle() {
        var room = new RoomControl();
        room.rememberHost("host", "Laptop");
        room.openTerminal("host");
        for (int i = 2; i <= 5; i++) {
            var terminal = room.openTerminal("host");
            room.confirmTerminalOpened("host", terminal.terminalId(), "runtime-" + i);
        }
        room.renameTerminal(2, "API logs");
        room.updateTerminalGeometry(2, new Geometry(-12.5, 80, 720, 480));
        room.updateTerminalMetadata("host", 2, new Metadata("/work", "main", "java"));
        room.setTerminalMode(2, Mode.SHARED, "host");
        room.terminalExited("host", 4, 9.0);
        room.terminalExited("host", 5, null);
        room.acquireLease("alice", 3);
        room.acquireLease("alice", 1);
        return room;
    }
}

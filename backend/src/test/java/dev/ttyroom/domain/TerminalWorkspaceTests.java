package dev.ttyroom.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import dev.ttyroom.domain.TerminalWorkspace.*;
import dev.ttyroom.domain.TerminalWorkspace.Runtime;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.util.List;

class TerminalWorkspaceTests {
    @Test
    void reconciliationRetainsMatchingRuntimeClosesMissingAndConflictingOnesAndRecoversNewOnes() {
        var workspace = new TerminalWorkspace();
        workspace.reconcile("host", List.of(runtime(1), runtime(2), runtime(3)));
        var before = workspace.snapshot();

        var result =
                workspace.reconcile(
                        "host", List.of(runtime(1), new Runtime(2, "conflict"), runtime(4)));

        assertThat(result.active()).containsExactly(1L, 4L);
        assertThat(result.closed()).containsExactly(2L, 3L);
        assertThat(result.toClose()).containsExactly(2L);
        assertThat(result.recovered()).extracting(Terminal::terminalId).containsExactly(4L);
        assertThat(workspace.snapshot())
                .extracting(Terminal::status)
                .containsExactly(Status.OPEN, Status.EXITED, Status.EXITED, Status.OPEN);
        assertThat(workspace.snapshot().getFirst()).isEqualTo(before.getFirst());
        assertThat(before)
                .allSatisfy(terminal -> assertThat(terminal.status()).isEqualTo(Status.OPEN));
    }

    @Test
    void foreignAndExitedIdsCannotBeTakenOverAndLastDuplicateRuntimeWins() {
        var workspace = new TerminalWorkspace();
        workspace.reconcile("other", List.of(runtime(1)));
        workspace.reconcile("host", List.of(runtime(2)));
        workspace.reconcile("host", List.of());

        var result =
                workspace.reconcile(
                        "host",
                        List.of(
                                runtime(1),
                                runtime(2),
                                new Runtime(3, "old"),
                                new Runtime(3, "new")));
        var repeated = workspace.reconcile("host", List.of(new Runtime(3, "new")));

        assertThat(result.toClose()).containsExactly(1L, 2L);
        assertThat(result.active()).containsExactly(3L);
        assertThat(repeated.active()).containsExactly(3L);
        assertThat(repeated.recovered()).isEmpty();
        assertThat(workspace.ownsOpen("other", 1)).isTrue();
        assertThat(workspace.ownsOpen("host", 1)).isFalse();
        assertThat(workspace.ownsOpen("host", 2)).isFalse();
    }

    @Test
    void hostRemovalCleansUpItsOpenAndExitedTerminalsOnly() {
        var workspace = new TerminalWorkspace();
        workspace.reconcile("host", List.of(runtime(1), runtime(2)));
        workspace.reconcile("host", List.of(runtime(1)));
        workspace.reconcile("other", List.of(runtime(3)));

        var removed = workspace.removeHost("host");

        assertThat(removed).containsExactly(1L, 2L);
        assertThat(workspace.snapshot()).extracting(Terminal::terminalId).containsExactly(3L);
    }

    @Test
    void generatedIdsFollowRecoveredIdsAndAreNeverRewoundByHostRemoval() {
        var workspace = new TerminalWorkspace();
        workspace.reconcile("host", List.of(runtime(7), runtime(20)));

        var first = workspace.open("host");
        var second = workspace.open("other");
        workspace.removeHost("host");
        var third = workspace.open("other");

        assertThat(List.of(first.terminalId(), second.terminalId(), third.terminalId()))
                .containsExactly(21L, 22L, 23L);
        assertThat(workspace.snapshot()).extracting(Terminal::terminalId).containsExactly(22L, 23L);
    }

    @Test
    void inventoryBindsAnUnconfirmedReservationInsteadOfTreatingItAsARuntimeConflict() {
        var workspace = new TerminalWorkspace();
        var pending = workspace.open("host");

        var result =
                workspace.reconcile(
                        "host", List.of(new Runtime(pending.terminalId(), "reconnected")));
        var repeated =
                workspace.reconcile(
                        "host", List.of(new Runtime(pending.terminalId(), "reconnected")));

        assertThat(result.active()).containsExactly(pending.terminalId());
        assertThat(result.closed()).isEmpty();
        assertThat(result.toClose()).isEmpty();
        assertThat(result.recovered()).isEmpty();
        assertThat(repeated.active()).containsExactly(pending.terminalId());
    }

    @Test
    void
            onlyTheOwningHostCanConfirmAndDuplicateConfirmationKeepsTheLatestRuntimeWithoutAnotherEvent() {
        var workspace = new TerminalWorkspace();
        var terminal = workspace.open("host");

        var wrongOwner =
                catchThrowable(
                        () -> workspace.confirmOpened("other", terminal.terminalId(), "foreign"));
        var unknown = catchThrowable(() -> workspace.confirmOpened("host", 99, "unknown"));
        var first = workspace.confirmOpened("host", terminal.terminalId(), "first");
        var repeated = workspace.confirmOpened("host", terminal.terminalId(), "latest");
        var inventory =
                workspace.reconcile("host", List.of(new Runtime(terminal.terminalId(), "latest")));

        assertThat(wrongOwner).isInstanceOf(TerminalNotOwned.class);
        assertThat(unknown).isInstanceOf(TerminalNotOwned.class);
        assertThat(first).contains(terminal);
        assertThat(repeated).isEmpty();
        assertThat(inventory.active()).containsExactly(terminal.terminalId());
    }

    @Test
    void aMissingRuntimeExitsTheReservationAndLateConfirmationDoesNotReviveIt() {
        var workspace = new TerminalWorkspace();
        var pending = workspace.open("host");
        workspace.reconcile("host", List.of());

        var late = workspace.confirmOpened("host", pending.terminalId(), "late");
        var next = workspace.open("host");

        assertThat(late).isEmpty();
        assertThat(workspace.snapshot().getFirst().status()).isEqualTo(Status.EXITED);
        assertThat(next.terminalId()).isEqualTo(2);
    }

    @Test
    void exhaustionRejectsBeforeChangingTheWorkspaceAndDoesNotWrapToZero() {
        var workspace = new TerminalWorkspace();
        workspace.reconcile("host", List.of(new Runtime(0xffff_fffeL, "restored")));
        var last = workspace.open("host");
        var before = workspace.snapshot();

        var firstFailure = catchThrowable(() -> workspace.open("host"));
        var repeatedFailure = catchThrowable(() -> workspace.open("other"));

        assertThat(last.terminalId()).isEqualTo(0xffff_ffffL);
        assertThat(firstFailure).isInstanceOf(IdsExhausted.class);
        assertThat(repeatedFailure).isInstanceOf(IdsExhausted.class);
        assertThat(workspace.snapshot()).isEqualTo(before);
    }

    @Test
    void onlyTheOwningHostCanExitAndTheFirstExitCodeRemainsAuthoritative() {
        var workspace = new TerminalWorkspace();
        var terminal = workspace.open("host");

        var wrongOwner =
                catchThrowable(() -> workspace.markExited("other", terminal.terminalId(), 9.0));
        var exited = workspace.markExited("host", terminal.terminalId(), 7.0);
        var duplicate = workspace.markExited("host", terminal.terminalId(), 9.0);
        var lateConfirmation = workspace.confirmOpened("host", terminal.terminalId(), "late");

        assertThat(wrongOwner).isInstanceOf(TerminalNotOwned.class);
        assertThat(exited).isTrue();
        assertThat(duplicate).isFalse();
        assertThat(lateConfirmation).isEmpty();
        assertThat(workspace.snapshot().getFirst().exitCode()).isEqualTo(7.0);
        assertThat(workspace.ownsOpen("host", terminal.terminalId())).isFalse();
    }

    @Test
    void metadataChangesPreserveRuntimeAndEarlierSnapshotsAndCompareValues() {
        var workspace = new TerminalWorkspace();
        workspace.reconcile("host", List.of(runtime(7)));
        var before = workspace.snapshot();
        var metadata = new Metadata("/workspace", "main", "sh");

        var changed = workspace.updateMetadata("host", 7, metadata);
        var duplicate =
                workspace.updateMetadata("host", 7, new Metadata("/workspace", "main", "sh"));
        var inventory = workspace.reconcile("host", List.of(runtime(7)));

        assertThat(changed).isTrue();
        assertThat(duplicate).isFalse();
        assertThat(before.getFirst().meta()).isEqualTo(new Metadata(null, null, null));
        assertThat(workspace.snapshot().getFirst().meta()).isEqualTo(metadata);
        assertThat(workspace.snapshot().getFirst())
                .usingRecursiveComparison()
                .ignoringFields("meta")
                .isEqualTo(before.getFirst());
        assertThat(inventory.active()).containsExactly(7L);
        assertThat(inventory.closed()).isEmpty();
    }

    @Test
    void onlyTheOwnerCanUpdateMetadataIncludingAfterExitWithoutChangingTheExitCode() {
        var workspace = new TerminalWorkspace();
        workspace.reconcile("host", List.of(runtime(7)));
        workspace.markExited("host", 7, 9.0);
        var before = workspace.snapshot();
        var metadata = new Metadata("/workspace", null, null);

        var foreign = catchThrowable(() -> workspace.updateMetadata("other", 7, metadata));
        var unknown = catchThrowable(() -> workspace.updateMetadata("host", 99, metadata));
        var afterRejected = workspace.snapshot();
        var changed = workspace.updateMetadata("host", 7, metadata);

        assertThat(foreign).isInstanceOf(TerminalNotOwned.class);
        assertThat(unknown).isInstanceOf(TerminalNotOwned.class);
        assertThat(afterRejected).isEqualTo(before);
        assertThat(changed).isTrue();
        assertThat(workspace.snapshot().getFirst().meta()).isEqualTo(metadata);
        assertThat(workspace.snapshot().getFirst())
                .usingRecursiveComparison()
                .ignoringFields("meta")
                .isEqualTo(before.getFirst());
    }

    enum UnconfirmedOrigin {
        RESERVATION,
        INVENTORY_BOUND_RESERVATION,
        RECOVERED_RUNTIME
    }

    @ParameterizedTest
    @EnumSource(UnconfirmedOrigin.class)
    void runtimeRecoveryDoesNotConsumeTheFirstConfirmation(UnconfirmedOrigin origin) {
        var workspace = new TerminalWorkspace();
        var terminal = unconfirmedTerminal(workspace, origin);

        var first = workspace.confirmOpened("host", terminal.terminalId(), "confirmed");
        var repeated = workspace.confirmOpened("host", terminal.terminalId(), "latest");
        var inventory =
                workspace.reconcile("host", List.of(new Runtime(terminal.terminalId(), "latest")));

        assertThat(first).contains(terminal);
        assertThat(repeated).isEmpty();
        assertThat(inventory.active()).containsExactly(terminal.terminalId());
        assertThat(inventory.closed()).isEmpty();
        assertThat(workspace.snapshot()).containsExactly(terminal);
    }

    @Test
    void pendingMetadataDoesNotPreventInventoryFromBindingTheRuntime() {
        var workspace = new TerminalWorkspace();
        var pending = workspace.open("host");
        var before = workspace.snapshot();
        var metadata = new Metadata("/pending", "main", "sh");

        workspace.updateMetadata("host", pending.terminalId(), metadata);
        var inventory =
                workspace.reconcile("host", List.of(new Runtime(pending.terminalId(), "attached")));

        assertThat(pending.status()).isEqualTo(Status.OPEN);
        assertThat(pending.exitCode()).isNull();
        assertThat(inventory.active()).containsExactly(pending.terminalId());
        assertThat(inventory.recovered()).isEmpty();
        assertThat(workspace.find(pending.terminalId()).orElseThrow().meta()).isEqualTo(metadata);
        assertThat(before.getFirst().meta()).isEqualTo(new Metadata(null, null, null));
    }

    @Test
    void firstExitOfRunningTerminalSurvivesLateConfirmationAndInventory() {
        var workspace = new TerminalWorkspace();
        var running = workspace.open("host");
        workspace.confirmOpened("host", running.terminalId(), "running");
        var before = workspace.snapshot();

        var first = workspace.markExited("host", running.terminalId(), 4294967296.0);
        var duplicate = workspace.markExited("host", running.terminalId(), 9.0);
        var late = workspace.confirmOpened("host", running.terminalId(), "late");
        var inventory =
                workspace.reconcile("host", List.of(new Runtime(running.terminalId(), "running")));

        assertThat(first).isTrue();
        assertThat(duplicate).isFalse();
        assertThat(late).isEmpty();
        assertThat(inventory.active()).isEmpty();
        assertThat(inventory.closed()).isEmpty();
        assertThat(inventory.toClose()).containsExactly(running.terminalId());
        assertThat(workspace.find(running.terminalId()).orElseThrow().status())
                .isEqualTo(Status.EXITED);
        assertThat(workspace.find(running.terminalId()).orElseThrow().exitCode())
                .isEqualTo(4294967296.0);
        assertThat(before).containsExactly(running);
    }

    @Test
    void inventoryLossKeepsUnknownExitCodeEvenAfterALaterExitReport() {
        var workspace = new TerminalWorkspace();
        var pending = workspace.open("host");
        workspace.reconcile("host", List.of());

        var lateExit = workspace.markExited("host", pending.terminalId(), 7.0);
        var lateConfirmation = workspace.confirmOpened("host", pending.terminalId(), "late");

        assertThat(lateExit).isFalse();
        assertThat(lateConfirmation).isEmpty();
        assertThat(workspace.find(pending.terminalId()).orElseThrow().status())
                .isEqualTo(Status.EXITED);
        assertThat(workspace.find(pending.terminalId()).orElseThrow().exitCode()).isNull();
    }

    private static Terminal unconfirmedTerminal(
            TerminalWorkspace workspace, UnconfirmedOrigin origin) {
        return switch (origin) {
            case RESERVATION -> workspace.open("host");
            case INVENTORY_BOUND_RESERVATION -> {
                var terminal = workspace.open("host");
                workspace.reconcile("host", List.of(runtime(terminal.terminalId())));
                yield terminal;
            }
            case RECOVERED_RUNTIME ->
                    workspace.reconcile("host", List.of(runtime(7))).recovered().getFirst();
        };
    }

    private static Runtime runtime(long id) {
        return new Runtime(id, "runtime-" + id);
    }
}

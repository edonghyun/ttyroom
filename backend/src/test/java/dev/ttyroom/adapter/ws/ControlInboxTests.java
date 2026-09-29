package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

class ControlInboxTests {
    @Test
    void finishDrainsAcceptedControlsInOrderButRejectsNewWork() {
        var executor = new ManualExecutor();
        var events = new ArrayList<String>();
        var inbox =
                new ControlInbox(
                        executor,
                        10,
                        failure -> {
                            throw new AssertionError(failure);
                        });
        inbox.offer(() -> events.add("first"), 2);
        inbox.offer(() -> events.add("second"), 2);

        inbox.finish();
        var late = inbox.offer(() -> events.add("late"), 1);
        executor.runWorker();

        assertThat(late).isFalse();
        assertThat(events).containsExactly("first", "second");
        assertThat(executor.submissions).isEqualTo(1);
    }

    @Test
    void byteBudgetIncludesTheRunningControlAndReleasesAfterCompletion() {
        var executor = new ManualExecutor();
        var admissions = new ArrayList<Boolean>();
        var inbox =
                new ControlInbox(
                        executor,
                        10,
                        failure -> {
                            throw new AssertionError(failure);
                        });
        inbox.offer(() -> admissions.add(inbox.offer(() -> {}, 6)), 6);

        executor.runWorker();
        var afterCompletion = inbox.offer(() -> {}, 10);
        executor.runWorker();

        assertThat(admissions).containsExactly(false);
        assertThat(afterCompletion).isTrue();
    }

    @Test
    void tinyControlsAlsoHaveABoundedCountAndDisconnectDiscardsWaitingWork() {
        var executor = new ManualExecutor();
        var ran = new ArrayList<Integer>();
        var inbox =
                new ControlInbox(
                        executor,
                        1000,
                        failure -> {
                            throw new AssertionError(failure);
                        });
        for (int i = 0; i < ControlInbox.MAX_PENDING; i++) inbox.offer(() -> ran.add(1), 1);

        var overflow = inbox.offer(() -> ran.add(2), 1);
        inbox.close();
        executor.runWorker();

        assertThat(overflow).isFalse();
        assertThat(ran).isEmpty();
    }

    @Test
    void failedControlReportsItsCauseAndDoesNotRunLaterControls() {
        var executor = new ManualExecutor();
        var failures = new ArrayList<Throwable>();
        var ran = new ArrayList<String>();
        var failure = new IllegalStateException("Storage unavailable");
        var inbox = new ControlInbox(executor, 10, failures::add);
        inbox.offer(
                () -> {
                    throw failure;
                },
                1);
        inbox.offer(() -> ran.add("later"), 1);

        executor.runWorker();
        var late = inbox.offer(() -> ran.add("late"), 1);

        assertThat(failures).containsExactly(failure);
        assertThat(ran).isEmpty();
        assertThat(late).isFalse();
    }

    @Test
    void stoppedExecutorCannotClaimToHaveAcceptedWork() {
        var inbox =
                new ControlInbox(
                        action -> {
                            throw new RejectedExecutionException();
                        },
                        10,
                        failure -> {
                            throw new AssertionError(failure);
                        });

        var accepted = inbox.offer(() -> {}, 1);

        assertThat(accepted).isFalse();
    }

    private static final class ManualExecutor implements Executor {
        Runnable worker;
        int submissions;

        public void execute(Runnable command) {
            worker = command;
            submissions++;
        }

        void runWorker() {
            var command = worker;
            worker = null;
            command.run();
        }
    }
}

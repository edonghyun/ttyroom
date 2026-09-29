package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

class ExpiryTimersTests {
    @Test
    void aWaitingExpiryDoesNotHoldTheTimerThreadOrAnotherRoomsExpiry() throws Exception {
        try (var timers = new ExpiryTimers();
                var first = new WaitingExpiry()) {
            var second = new CountDownLatch(1);
            timers.schedule(first, 0, TimeUnit.MILLISECONDS);
            first.awaitStarted();

            timers.schedule(second::countDown, 0, TimeUnit.MILLISECONDS);
            boolean independent = second.await(1, TimeUnit.SECONDS);

            assertThat(independent).isTrue();
        }
    }

    @Test
    void closeDrainsAnAlreadyDispatchedExpiry() throws Exception {
        try (var timers = new ExpiryTimers();
                var client = Executors.newVirtualThreadPerTaskExecutor();
                var expiry = new WaitingExpiry()) {
            timers.schedule(expiry, 0, TimeUnit.MILLISECONDS);
            expiry.awaitStarted();

            var closing = client.submit(timers::close);
            boolean closedWhileExpiryWasWaiting;
            try {
                closedWhileExpiryWasWaiting = completesWithin(closing, 100, TimeUnit.MILLISECONDS);
                expiry.release();
                closing.get(2, TimeUnit.SECONDS);
            } finally {
                expiry.release();
                closing.cancel(true);
            }
            boolean finishedAtClose = expiry.completed.isDone();

            assertThat(closedWhileExpiryWasWaiting).isFalse();
            assertThat(finishedAtClose).isTrue();
            assertThat(expiry.completed.isCompletedExceptionally()).isFalse();
        }
    }

    @Test
    void closeCancelsFutureDeliveryWithoutWaitingForItsDeadline() throws Exception {
        try (var timers = new ExpiryTimers();
                var client = Executors.newVirtualThreadPerTaskExecutor()) {
            var delivered = new AtomicBoolean();
            timers.schedule(() -> delivered.set(true), 1, TimeUnit.DAYS);

            var closing = client.submit(timers::close);
            try {
                closing.get(2, TimeUnit.SECONDS);
            } finally {
                closing.cancel(true);
            }

            assertThat(delivered).isFalse();
        }
    }

    @Test
    void cancellingAnAlreadyDispatchedExpiryDoesNotInterruptIt() throws Exception {
        try (var timers = new ExpiryTimers();
                var expiry = new WaitingExpiry()) {
            var cancellation = timers.schedule(expiry, 0, TimeUnit.MILLISECONDS);
            expiry.awaitStarted();

            cancellation.cancel();
            expiry.release();
            boolean interrupted = expiry.completed.get(2, TimeUnit.SECONDS);

            assertThat(interrupted).isFalse();
        }
    }

    @Test
    void aClosedTimerRejectsNewExpiries() {
        try (var timers = new ExpiryTimers()) {
            timers.close();

            assertThatThrownBy(() -> timers.schedule(() -> {}, 0, TimeUnit.MILLISECONDS))
                    .isInstanceOf(RejectedExecutionException.class);
        }
    }

    /**
     * Releasing before timer/client cleanup prevents a failed assertion from stranding shutdown.
     */
    private static final class WaitingExpiry implements Runnable, AutoCloseable {
        private final CountDownLatch started = new CountDownLatch(1);
        private final CountDownLatch released = new CountDownLatch(1);
        final CompletableFuture<Boolean> completed = new CompletableFuture<>();

        @Override
        public void run() {
            started.countDown();
            try {
                await(released);
                completed.complete(Thread.currentThread().isInterrupted());
            } catch (Throwable failure) {
                completed.completeExceptionally(failure);
            }
        }

        void awaitStarted() {
            await(started);
        }

        void release() {
            released.countDown();
        }

        @Override
        public void close() {
            release();
        }
    }

    private static boolean completesWithin(Future<?> operation, long duration, TimeUnit unit)
            throws Exception {
        try {
            operation.get(duration, unit);
            return true;
        } catch (TimeoutException stillRunning) {
            return false;
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(3, TimeUnit.SECONDS))
                throw new AssertionError("Expiry coordination timed out");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }
}

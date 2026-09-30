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
    void repeatedCancellationDoesNotRetainDueWorkBehindABlockedRoom() throws Exception {
        try (var timers = new ExpiryTimers(2);
                var waiting = new WaitingExpiry()) {
            var room = new Object();
            var delivered = new java.util.concurrent.atomic.AtomicInteger();
            timers.schedule(room, waiting, 0, TimeUnit.MILLISECONDS);
            waiting.awaitStarted();

            for (int i = 0; i < 1_000; i++) {
                var cancellation =
                        timers.schedule(room, delivered::incrementAndGet, 0, TimeUnit.MILLISECONDS);
                cancellation.cancel();
                cancellation.cancel();
            }
            var pendingAfterCancellation = pendingCount(timers);
            waiting.release();
            timers.close();

            assertThat(pendingAfterCancellation).isZero();
            assertThat(delivered).hasValue(0);
        }
    }

    @Test
    void shutdownCancelsDueWorkButDrainsTheExpiryAlreadyInProgress() throws Exception {
        try (var timers = new ExpiryTimers(1);
                var client = Executors.newVirtualThreadPerTaskExecutor();
                var waiting = new WaitingExpiry()) {
            var delivered = new AtomicBoolean();
            timers.schedule(new Object(), waiting, 0, TimeUnit.MILLISECONDS);
            waiting.awaitStarted();
            timers.schedule(new Object(), () -> delivered.set(true), 0, TimeUnit.MILLISECONDS);

            var closing = client.submit(timers::close);
            boolean finishedEarly = completesWithin(closing, 100, TimeUnit.MILLISECONDS);
            waiting.release();
            closing.get(2, TimeUnit.SECONDS);

            assertThat(finishedEarly).isFalse();
            assertThat(delivered).isFalse();
            assertThat(pendingCount(timers)).isZero();
        }
    }

    // Inspect retained callbacks without adding a production API used only by tests.
    private static int pendingCount(ExpiryTimers timers) throws Exception {
        var field = ExpiryTimers.class.getDeclaredField("pending");
        field.setAccessible(true);
        synchronized (timers) {
            return ((java.util.Set<?>) field.get(timers)).size();
        }
    }

    @Test
    void aWaitingRoomCannotDispatchAnotherExpiryWhileOtherRoomsProgress() throws Exception {
        try (var timers = new ExpiryTimers(2);
                var waiting = new WaitingExpiry()) {
            var room = new Object();
            var duplicate = new CountDownLatch(1);
            var healthy = new CountDownLatch(1);
            timers.schedule(room, waiting, 0, TimeUnit.MILLISECONDS);
            waiting.awaitStarted();

            timers.schedule(room, duplicate::countDown, 0, TimeUnit.MILLISECONDS);
            timers.schedule(new Object(), healthy::countDown, 0, TimeUnit.MILLISECONDS);
            boolean independent = healthy.await(1, TimeUnit.SECONDS);
            boolean overlapping = duplicate.getCount() == 0;
            waiting.release();
            boolean eventuallyDelivered = duplicate.await(1, TimeUnit.SECONDS);

            assertThat(independent).isTrue();
            assertThat(overlapping).isFalse();
            assertThat(eventuallyDelivered).isTrue();
        }
    }

    @Test
    void saturatedWorkersRetainDueWorkUntilCapacityReturns() throws Exception {
        try (var timers = new ExpiryTimers(1);
                var waiting = new WaitingExpiry()) {
            var next = new CountDownLatch(1);
            timers.schedule(new Object(), waiting, 0, TimeUnit.MILLISECONDS);
            waiting.awaitStarted();

            timers.schedule(new Object(), next::countDown, 0, TimeUnit.MILLISECONDS);
            boolean excess = next.await(100, TimeUnit.MILLISECONDS);
            waiting.release();
            boolean retained = next.await(1, TimeUnit.SECONDS);

            assertThat(excess).isFalse();
            assertThat(retained).isTrue();
        }
    }

    @Test
    void aWaitingExpiryDoesNotHoldTheTimerThreadOrAnotherRoomsExpiry() throws Exception {
        try (var timers = new ExpiryTimers();
                var first = new WaitingExpiry()) {
            var second = new CountDownLatch(1);
            timers.schedule(new Object(), first, 0, TimeUnit.MILLISECONDS);
            first.awaitStarted();

            timers.schedule(new Object(), second::countDown, 0, TimeUnit.MILLISECONDS);
            boolean independent = second.await(1, TimeUnit.SECONDS);

            assertThat(independent).isTrue();
        }
    }

    @Test
    void closeDrainsAnAlreadyDispatchedExpiry() throws Exception {
        try (var timers = new ExpiryTimers();
                var client = Executors.newVirtualThreadPerTaskExecutor();
                var expiry = new WaitingExpiry()) {
            timers.schedule(new Object(), expiry, 0, TimeUnit.MILLISECONDS);
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
            timers.schedule(new Object(), () -> delivered.set(true), 1, TimeUnit.DAYS);

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
            var cancellation = timers.schedule(new Object(), expiry, 0, TimeUnit.MILLISECONDS);
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

            assertThatThrownBy(
                            () -> timers.schedule(new Object(), () -> {}, 0, TimeUnit.MILLISECONDS))
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

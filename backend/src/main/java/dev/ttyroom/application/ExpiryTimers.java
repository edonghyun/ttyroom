package dev.ttyroom.application;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Timer delivery stays short; due expiries wait for their own room's storage independently. */
final class ExpiryTimers implements AutoCloseable {
    /** Cancels pending delivery without interrupting an expiry already dispatched to a worker. */
    @FunctionalInterface
    interface Cancellation {
        void cancel();
    }

    private final ScheduledThreadPoolExecutor delivery = new ScheduledThreadPoolExecutor(1);
    private final ExecutorService work = Executors.newVirtualThreadPerTaskExecutor();

    ExpiryTimers() {
        delivery.setRemoveOnCancelPolicy(true);
        delivery.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }

    Cancellation schedule(Runnable expiry, long delay, TimeUnit unit) {
        var pending = delivery.schedule(() -> work.execute(expiry), delay, unit);
        return () -> pending.cancel(false);
    }

    /** Cancels future delivery and waits for already dispatched expiries to finish. */
    @Override
    public void close() {
        // Stop delivery before closing worker intake so no accepted expiry is lost between them.
        delivery.close();
        work.close();
    }
}

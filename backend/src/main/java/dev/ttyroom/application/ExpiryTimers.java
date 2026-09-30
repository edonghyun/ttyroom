package dev.ttyroom.application;

import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Delivers at most one expiry per room and four globally. RoomSessions bounds waiting work by
 * membership and cancels it on replacement/removal; saturation delays cleanup, never drops it.
 */
final class ExpiryTimers implements AutoCloseable {
    /** Cancels waiting delivery without interrupting an expiry already dispatched to a worker. */
    @FunctionalInterface
    interface Cancellation {
        void cancel();
    }

    private final ScheduledThreadPoolExecutor delivery = new ScheduledThreadPoolExecutor(1);
    private final ExecutorService work = Executors.newVirtualThreadPerTaskExecutor();
    private final Set<Task> pending = new LinkedHashSet<>();
    private final Set<Object> runningRooms = new HashSet<>();
    private final int parallelism;
    private boolean stopped;

    ExpiryTimers() {
        this(4);
    }

    ExpiryTimers(int parallelism) {
        if (parallelism < 1) throw new IllegalArgumentException("Invalid expiry parallelism");
        this.parallelism = parallelism;
        delivery.setRemoveOnCancelPolicy(true);
        delivery.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }

    synchronized Cancellation schedule(Object room, Runnable expiry, long delay, TimeUnit unit) {
        if (stopped) throw new RejectedExecutionException("Expiry timers are closed");
        var task = new Task(room, expiry);
        pending.add(task);
        task.deadline = delivery.schedule(() -> due(task), delay, unit);
        return () -> cancel(task);
    }

    private synchronized void due(Task task) {
        if (!pending.contains(task)) return;
        task.due = true;
        dispatchReady();
    }

    private synchronized void cancel(Task task) {
        if (pending.remove(task)) task.deadline.cancel(false);
    }

    /** Called under the timer monitor; workers acquire room/storage locks after leaving it. */
    private void dispatchReady() {
        while (!stopped && runningRooms.size() < parallelism) {
            var available =
                    pending.stream()
                            .filter(task -> task.due && !runningRooms.contains(task.room))
                            .findFirst()
                            .orElse(null);
            if (available == null) return;
            pending.remove(available);
            runningRooms.add(available.room);
            work.execute(
                    () -> {
                        try {
                            available.expiry.run();
                        } finally {
                            synchronized (ExpiryTimers.this) {
                                runningRooms.remove(available.room);
                                dispatchReady();
                            }
                        }
                    });
        }
    }

    /** Cancels waiting work and drains already dispatched expiries without interrupting storage. */
    @Override
    public void close() {
        synchronized (this) {
            stopped = true;
            pending.forEach(task -> task.deadline.cancel(false));
            pending.clear();
        }
        delivery.close();
        work.close();
    }

    private static final class Task {
        final Object room;
        final Runnable expiry;
        ScheduledFuture<?> deadline;
        boolean due;

        Task(Object room, Runnable expiry) {
            this.room = room;
            this.expiry = expiry;
        }
    }
}

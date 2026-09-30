package dev.ttyroom.adapter.ws;

import java.util.ArrayDeque;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Consumer;

/** Bounded FIFO off the receive callback. At most one worker runs each connection's controls. */
final class ControlInbox {
    static final int MAX_PENDING = 256;

    private record Command(Runnable action, int bytes, BufferEvents.ControlQueueWait waiting) {}

    private final ArrayDeque<Command> queue = new ArrayDeque<>();
    private final Executor executor;
    private final Consumer<Throwable> onFailure;
    private final long maxBytes;
    private long pendingBytes;
    private int pending;
    private boolean running;
    private boolean closed;

    ControlInbox(Executor executor, long maxBytes, Consumer<Throwable> onFailure) {
        this.executor = executor;
        this.maxBytes = maxBytes;
        this.onFailure = onFailure;
    }

    synchronized boolean offer(Runnable action, int bytes) {
        if (closed) return false;
        if (pending >= MAX_PENDING || bytes > maxBytes - pendingBytes) {
            BufferEvents.pressure("control-inbox", "rejected", pendingBytes, pending);
            return false;
        }
        queue.addLast(new Command(action, bytes, BufferEvents.queued()));
        pending++;
        pendingBytes += bytes;
        if (!running) {
            running = true;
            try {
                executor.execute(this::drain);
            } catch (RejectedExecutionException stopped) {
                running = false;
                close();
                return false;
            }
        }
        return true;
    }

    private void drain() {
        for (; ; ) {
            Command command;
            synchronized (this) {
                command = queue.pollFirst();
                if (command == null) {
                    running = false;
                    return;
                }
            }
            try {
                BufferEvents.started(command.waiting());
                command.action().run();
            } catch (RuntimeException | Error failure) {
                close();
                onFailure.accept(failure);
            } finally {
                synchronized (this) {
                    pending--;
                    pendingBytes -= command.bytes();
                }
            }
        }
    }

    /** Stop accepting new controls, retaining accepted work for graceful shutdown. */
    synchronized void finish() {
        closed = true;
    }

    /** Drop waiting work; an operation already in storage must finish its commit. */
    synchronized void close() {
        closed = true;
        for (var command : queue) {
            pending--;
            pendingBytes -= command.bytes();
        }
        queue.clear();
    }
}

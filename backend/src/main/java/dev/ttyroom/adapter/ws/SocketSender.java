package dev.ttyroom.adapter.ws;

import dev.ttyroom.application.OutputFrame;
import dev.ttyroom.application.RoomSessions.PeerUnavailable;

import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Owns one socket's writes and close. Callers only enqueue immutable messages; network I/O never
 * runs on their thread. Limits include the in-flight message as well as queued messages.
 */
final class SocketSender {
    record Limits(int bytes, int messages, Duration writeTimeout) {
        Limits {
            if (bytes <= 0 || messages <= 0 || writeTimeout.isNegative() || writeTimeout.isZero())
                throw new IllegalArgumentException("Sender limits must be positive");
        }
    }

    private sealed interface Delivery permits Pending, Replay {
        Pending next();

        boolean finished();
    }

    private record Pending(WebSocketMessage<?> message, int bytes) implements Delivery {
        public Pending next() {
            return this;
        }

        public boolean finished() {
            return true;
        }
    }

    /** Only the writer advances this snapshot. Binary encoding is deferred until each write. */
    private static final class Replay implements Delivery {
        final List<OutputFrame> frames;
        final TextMessage boundary;
        final long bytes;
        private int cursor;

        Replay(List<OutputFrame> frames, TextMessage boundary) {
            this.frames = List.copyOf(frames);
            this.boundary = boundary;
            this.bytes =
                    this.frames.stream().mapToLong(frame -> 9L + frame.size()).sum()
                            + boundary.getPayloadLength();
        }

        public Pending next() {
            WebSocketMessage<?> message =
                    cursor < frames.size()
                            ? new BinaryMessage(OutputWire.encode(frames.get(cursor)))
                            : boundary;
            cursor++;
            return new Pending(message, message.getPayloadLength());
        }

        public boolean finished() {
            return cursor > frames.size();
        }
    }

    private static final Limits DEFAULT_LIMITS = new Limits(1_048_576, 256, Duration.ofSeconds(5));
    // Separate from live/control capacity: retained snapshots are not pre-encoded messages.
    // Budgets include an in-flight replay and are released only after its final sync.
    private static final int REPLAY_BYTES = 4 * 1_048_576;
    private static final int REPLAY_FRAMES = 65_536;
    private static final int REPLAY_REQUESTS = 16;
    private long replayBytes;
    private int replayFrames;
    private int replayRequests;
    private final WebSocketSession socket;
    private final ScheduledExecutorService deadlines;
    private final Runnable onClosed;
    private final Limits limits;
    private final ArrayDeque<Delivery> queue = new ArrayDeque<>();
    private final Thread writer;
    private int pendingBytes;
    private int pendingMessages;
    private Pending writing;
    private boolean finishing;
    private boolean terminated;
    private CloseStatus closeStatus = CloseStatus.NORMAL;

    SocketSender(WebSocketSession socket, ScheduledExecutorService deadlines, Runnable onClosed) {
        this(socket, deadlines, onClosed, DEFAULT_LIMITS);
    }

    SocketSender(
            WebSocketSession socket,
            ScheduledExecutorService deadlines,
            Runnable onClosed,
            Limits limits) {
        this.socket = socket;
        this.deadlines = deadlines;
        this.onClosed = onClosed;
        this.limits = limits;
        writer = Thread.ofVirtual().name("ttyroom-socket-writer").unstarted(this::writeMessages);
        writer.start();
    }

    /** Acceptance into the bounded queue is not a delivery acknowledgement. */
    void send(WebSocketMessage<?> message) {
        if (offer(List.of(message))) return;
        abort(CloseStatus.POLICY_VIOLATION.withReason("outbound queue limit"));
        throw new PeerUnavailable("WebSocket outbound queue limit exceeded");
    }

    /** Accept a gap marker and its following output as one ordered batch, or accept none. */
    boolean offer(List<? extends WebSocketMessage<?>> messages) {
        var batch =
                messages.stream()
                        .map(message -> new Pending(message, message.getPayloadLength()))
                        .toList();
        long bytes = batch.stream().mapToLong(Pending::bytes).sum();
        synchronized (this) {
            if (finishing || terminated) throw new PeerUnavailable("WebSocket sender is closed");
            if (bytes > limits.bytes() - pendingBytes
                    || batch.size() > limits.messages() - pendingMessages) {
                BufferEvents.pressure("outbound", "rejected", pendingBytes, pendingMessages);
                return false;
            }
            queue.addAll(batch);
            pendingBytes += (int) bytes;
            pendingMessages += batch.size();
            notifyAll();
            return true;
        }
    }

    /** Drop live output at the configured backlog threshold, without dropping control or replay. */
    synchronized boolean offerOutput(
            List<? extends WebSocketMessage<?>> messages, long dropThreshold) {
        if (finishing || terminated) throw new PeerUnavailable("WebSocket sender is closed");
        boolean accepted = pendingBytes + replayBytes < dropThreshold && offer(messages);
        if (!accepted)
            BufferEvents.pressure(
                    "outbound", "live-drop", pendingBytes + replayBytes, pendingMessages);
        return accepted;
    }

    /** Reserve the whole snapshot or close; never partially enqueue a replay. */
    void replay(List<OutputFrame> frames, TextMessage boundary) {
        var replay = new Replay(frames, boundary);
        synchronized (this) {
            if (finishing || terminated) throw new PeerUnavailable("WebSocket sender is closed");
            if (replay.bytes <= REPLAY_BYTES - replayBytes
                    && replay.frames.size() <= REPLAY_FRAMES - replayFrames
                    && replayRequests < REPLAY_REQUESTS) {
                queue.addLast(replay);
                replayBytes += replay.bytes;
                replayFrames += replay.frames.size();
                replayRequests++;
                notifyAll();
                return;
            }
            BufferEvents.pressure("replay", "rejected", replayBytes, replayRequests);
        }
        abort(CloseStatus.POLICY_VIOLATION.withReason("outbound replay limit"));
        throw new PeerUnavailable("WebSocket replay budget exceeded");
    }

    /** Drain accepted messages before closing, so a rejection error precedes the close frame. */
    synchronized void finish(CloseStatus status) {
        if (finishing || terminated) return;
        finishing = true;
        closeStatus = status;
        notifyAll();
    }

    /** Discard pending messages and release logical membership without waiting for network I/O. */
    void abort(CloseStatus status) {
        synchronized (this) {
            if (terminated) return;
            terminate();
        }
        closeTransport(status);
    }

    private void writeMessages() {
        try {
            while (true) {
                Delivery delivery;
                CloseStatus completed;
                synchronized (this) {
                    while (queue.isEmpty() && !finishing && !terminated) wait();
                    if (terminated) return;
                    delivery = queue.peekFirst();
                    completed = closeStatus;
                }
                if (delivery == null) {
                    abort(completed);
                    return;
                }
                // Encoding can copy a large payload; do not hold the sender or room monitor.
                var message = delivery.next();
                synchronized (this) {
                    if (terminated) return;
                    writing = message;
                }
                var deadline =
                        deadlines.schedule(
                                () -> writeTimedOut(message),
                                limits.writeTimeout().toNanos(),
                                TimeUnit.NANOSECONDS);
                try {
                    socket.sendMessage(message.message());
                } finally {
                    synchronized (this) {
                        if (!terminated) {
                            writing = null;
                            if (delivery.finished()) {
                                queue.removeFirst();
                                switch (delivery) {
                                    case Pending pending -> {
                                        pendingBytes -= pending.bytes();
                                        pendingMessages--;
                                    }
                                    case Replay replay -> {
                                        replayBytes -= replay.bytes;
                                        replayFrames -= replay.frames.size();
                                        replayRequests--;
                                    }
                                }
                            }
                        }
                    }
                    deadline.cancel(false);
                }
            }
        } catch (IOException | IllegalStateException unavailable) {
            abort(CloseStatus.SERVER_ERROR);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } finally {
            // Also clean up after unexpected programming errors, which escape this worker.
            abort(CloseStatus.SERVER_ERROR);
        }
    }

    private void writeTimedOut(Pending message) {
        synchronized (this) {
            // A cancelled deadline may already be running; it must not close a later write.
            if (terminated || writing != message) return;
            terminate();
        }
        closeTransport(CloseStatus.SERVER_ERROR.withReason("outbound write timeout"));
    }

    // Requires this monitor. Neither the callback nor socket operations run under it.
    private void terminate() {
        terminated = true;
        queue.clear();
        writing = null;
        pendingBytes = 0;
        pendingMessages = 0;
        replayBytes = 0;
        replayFrames = 0;
        replayRequests = 0;
        notifyAll();
    }

    private void closeTransport(CloseStatus status) {
        writer.interrupt();
        Thread.startVirtualThread(
                () -> {
                    try {
                        onClosed.run();
                    } finally {
                        try {
                            if (socket.isOpen()) socket.close(status);
                        } catch (IOException | IllegalStateException ignored) {
                            // Logical closure has completed even if the transport cannot close
                            // cleanly.
                        }
                    }
                });
    }
}

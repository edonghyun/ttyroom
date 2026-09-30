package dev.ttyroom.adapter.ws;

import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * One connection's partial messages. Memory grows with received data, not the configured ceiling.
 * Null means incomplete or closed. Callers only dispatch complete messages to the protocol.
 */
final class IncomingMessages {
    static final class TooLarge extends RuntimeException {}

    private final int textBytes;
    private final ScheduledExecutorService deadlines;
    private final Runnable onTimeout;
    private ScheduledFuture<?> deadline;
    private long generation;
    private int receivedTextBytes;
    private boolean highSurrogate;
    private final int binaryBytes;
    private StringBuilder text;
    private ByteArrayOutputStream binary;
    private boolean closed;

    IncomingMessages(
            int textBytes,
            int binaryBytes,
            ScheduledExecutorService deadlines,
            Runnable onTimeout) {
        this.textBytes = textBytes;
        this.deadlines = deadlines;
        this.onTimeout = onTimeout;
        this.binaryBytes = binaryBytes;
    }

    synchronized TextMessage receive(TextMessage part) {
        if (closed) return null;
        countText(part.getPayload());
        if (text == null && part.isLast()) {
            resetText();
            return part;
        }
        startDeadline();
        if (text == null) text = new StringBuilder();
        text.append(part.getPayload());
        if (!part.isLast()) return null;
        var complete = new TextMessage(text.toString());
        text = null;
        resetText();
        cancelDeadline();
        return complete;
    }

    synchronized BinaryMessage receive(BinaryMessage part) {
        if (closed) return null;
        if (part.getPayloadLength() > binaryBytes - (binary == null ? 0 : binary.size())) {
            close();
            throw new TooLarge();
        }
        if (binary == null && part.isLast()) return part;
        startDeadline();
        if (binary == null) binary = new ByteArrayOutputStream();
        var bytes = new byte[part.getPayloadLength()];
        part.getPayload().duplicate().get(bytes);
        binary.writeBytes(bytes);
        if (!part.isLast()) return null;
        var complete = new BinaryMessage(binary.toByteArray());
        binary = null;
        cancelDeadline();
        return complete;
    }

    synchronized void close() {
        closed = true;
        cancelDeadline();
        resetText();
        text = null;
        binary = null;
    }

    // Count UTF-8 without allocating a second copy. A split surrogate pair contributes 1+3 bytes;
    // an unpaired surrogate uses Java's one-byte replacement, matching the complete-message count.
    private void countText(String part) {
        for (int i = 0; i < part.length(); i++) {
            char ch = part.charAt(i);
            int bytes;
            if (highSurrogate && Character.isLowSurrogate(ch)) {
                bytes = 3;
                highSurrogate = false;
            } else {
                highSurrogate = Character.isHighSurrogate(ch);
                bytes = ch < 0x80 || Character.isSurrogate(ch) ? 1 : ch < 0x800 ? 2 : 3;
            }
            if (bytes > textBytes - receivedTextBytes) {
                close();
                throw new TooLarge();
            }
            receivedTextBytes += bytes;
        }
    }

    private void resetText() {
        receivedTextBytes = 0;
        highSurrogate = false;
    }

    private void startDeadline() {
        if (deadline != null) return;
        long message = ++generation;
        deadline = deadlines.schedule(() -> expire(message), 5, TimeUnit.SECONDS);
    }

    private void cancelDeadline() {
        generation++;
        if (deadline != null) deadline.cancel(false);
        deadline = null;
    }

    private void expire(long message) {
        synchronized (this) {
            if (closed || message != generation) return;
            close();
        }
        // The callback must not block the shared timer or run under the assembly monitor.
        onTimeout.run();
    }
}

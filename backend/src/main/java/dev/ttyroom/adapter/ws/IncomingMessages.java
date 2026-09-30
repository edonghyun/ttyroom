package dev.ttyroom.adapter.ws;

import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;

import java.io.ByteArrayOutputStream;

/**
 * One connection's partial messages. Memory grows with received data, not the configured ceiling.
 * Null means incomplete or closed. Callers only dispatch complete messages to the protocol.
 */
final class IncomingMessages {
    static final class TooLarge extends RuntimeException {}

    private final int textCharacters;
    private final int binaryBytes;
    private StringBuilder text;
    private ByteArrayOutputStream binary;
    private boolean closed;

    IncomingMessages(int textCharacters, int binaryBytes) {
        this.textCharacters = textCharacters;
        this.binaryBytes = binaryBytes;
    }

    synchronized TextMessage receive(TextMessage part) {
        if (closed) return null;
        // UTF-16 length never exceeds the UTF-8 byte length of valid wire text. This bounds an
        // incomplete message; the handler still checks the exact UTF-8 limit before dispatch.
        if (part.getPayload().length() > textCharacters - (text == null ? 0 : text.length())) {
            close();
            throw new TooLarge();
        }
        if (text == null && part.isLast()) return part;
        if (text == null) text = new StringBuilder();
        text.append(part.getPayload());
        if (!part.isLast()) return null;
        var complete = new TextMessage(text.toString());
        text = null;
        return complete;
    }

    synchronized BinaryMessage receive(BinaryMessage part) {
        if (closed) return null;
        if (part.getPayloadLength() > binaryBytes - (binary == null ? 0 : binary.size())) {
            close();
            throw new TooLarge();
        }
        if (binary == null && part.isLast()) return part;
        if (binary == null) binary = new ByteArrayOutputStream();
        var bytes = new byte[part.getPayloadLength()];
        part.getPayload().duplicate().get(bytes);
        binary.writeBytes(bytes);
        if (!part.isLast()) return null;
        var complete = new BinaryMessage(binary.toByteArray());
        binary = null;
        return complete;
    }

    synchronized void close() {
        closed = true;
        text = null;
        binary = null;
    }
}

package dev.ttyroom.adapter.ws;

import dev.ttyroom.application.InputFrame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Protocol v7 input: tag + terminal/sequence/lease network-order u32 values + opaque bytes. */
final class InputWire {
    private InputWire() {}

    static InputFrame decode(ByteBuffer incoming) {
        var bytes = incoming.slice().order(ByteOrder.BIG_ENDIAN);
        if (bytes.remaining() < 13 || bytes.get() != 2) return null;
        long terminalId = Integer.toUnsignedLong(bytes.getInt());
        long seq = Integer.toUnsignedLong(bytes.getInt());
        long leaseId = Integer.toUnsignedLong(bytes.getInt());
        var payload = new byte[bytes.remaining()];
        bytes.get(payload);
        return new InputFrame(terminalId, seq, leaseId, payload);
    }

    static byte[] encode(InputFrame frame) {
        return ByteBuffer.allocate(13 + frame.size())
                .order(ByteOrder.BIG_ENDIAN)
                .put((byte) 2)
                .putInt((int) frame.terminalId())
                .putInt((int) frame.seq())
                .putInt((int) frame.leaseId())
                .put(frame.payload())
                .array();
    }
}

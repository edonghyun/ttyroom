package dev.ttyroom.adapter.ws;

import dev.ttyroom.application.OutputFrame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Protocol v7 output frames: tag + two network-order u32 values + opaque bytes. */
final class OutputWire {
    private OutputWire() {}

    static OutputFrame decode(ByteBuffer incoming) {
        var bytes = incoming.slice().order(ByteOrder.BIG_ENDIAN);
        if (bytes.remaining() < 9 || bytes.get() != 1) return null;
        long terminalId = Integer.toUnsignedLong(bytes.getInt());
        long seq = Integer.toUnsignedLong(bytes.getInt());
        var payload = new byte[bytes.remaining()];
        bytes.get(payload);
        return new OutputFrame(terminalId, seq, payload);
    }

    static byte[] encode(OutputFrame frame) {
        return ByteBuffer.allocate(9 + frame.size())
                .order(ByteOrder.BIG_ENDIAN)
                .put((byte) 1)
                .putInt((int) frame.terminalId())
                .putInt((int) frame.seq())
                .put(frame.payload())
                .array();
    }
}

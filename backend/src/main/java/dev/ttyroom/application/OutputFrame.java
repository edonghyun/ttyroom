package dev.ttyroom.application;

/** An owned copy of opaque terminal bytes; source and browser sequences share the u32 range. */
public record OutputFrame(long terminalId, long seq, byte[] payload) {
    public OutputFrame {
        if (terminalId < 0 || terminalId > 0xffff_ffffL || seq < 0 || seq > 0xffff_ffffL)
            throw new IllegalArgumentException("Output identifiers and sequence must be u32");
        payload = payload.clone();
    }

    @Override
    public byte[] payload() {
        return payload.clone();
    }

    public int size() {
        return payload.length;
    }
}

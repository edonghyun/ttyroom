package dev.ttyroom.application;

/**
 * Opaque participant input. Sequence is forwarded, not an execution acknowledgement or dedupe key.
 */
public record InputFrame(long terminalId, long seq, long leaseId, byte[] payload) {
    public InputFrame {
        if (terminalId < 0
                || terminalId > 0xffff_ffffL
                || seq < 0
                || seq > 0xffff_ffffL
                || leaseId < 0
                || leaseId > 0xffff_ffffL)
            throw new IllegalArgumentException("Input identifiers and sequence must be u32");
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

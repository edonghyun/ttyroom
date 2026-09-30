package dev.ttyroom.application;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

/** Room-scoped output history, source deduplication and slow-recipient gaps. */
final class TerminalOutput {
    private static final int DEFAULT_BYTES = 1_048_576;
    private static final int MAX_FRAMES = 16_384;
    private final long maxBytes;
    private final int maxFrames;
    private final Map<Long, Stream> streams = new HashMap<>();
    private final Map<RoomSessions.Peer, Map<Long, RoomNotice.OutputGap>> gaps =
            new WeakHashMap<>();

    TerminalOutput() {
        this(DEFAULT_BYTES, MAX_FRAMES);
    }

    TerminalOutput(long maxBytes) {
        this(maxBytes, MAX_FRAMES);
    }

    TerminalOutput(long maxBytes, int maxFrames) {
        this.maxBytes = maxBytes;
        this.maxFrames = maxFrames;
    }

    private static final class Stream {
        long sourceSeq;
        long browserSeq;
        long bytes;
        final ArrayDeque<OutputFrame> history = new ArrayDeque<>();
    }

    OutputFrame accept(OutputFrame incoming) {
        var stream = streams.computeIfAbsent(incoming.terminalId(), ignored -> new Stream());
        if (incoming.seq() <= stream.sourceSeq) return null;
        var frame =
                new OutputFrame(incoming.terminalId(), stream.browserSeq + 1, incoming.payload());
        stream.sourceSeq = incoming.seq();
        stream.browserSeq = frame.seq();
        stream.history.addLast(frame);
        stream.bytes += frame.size();
        while (stream.bytes > maxBytes || stream.history.size() > maxFrames) {
            stream.bytes -= stream.history.removeFirst().size();
        }
        return frame;
    }

    void deliver(RoomSessions.Peer peer, OutputFrame frame) {
        var peerGaps = gaps.get(peer);
        var gap = peerGaps == null ? null : peerGaps.get(frame.terminalId());
        if (peer.offerOutput(frame, gap)) {
            if (peerGaps != null) {
                peerGaps.remove(frame.terminalId());
                if (peerGaps.isEmpty()) gaps.remove(peer);
            }
        } else {
            gaps.computeIfAbsent(peer, ignored -> new HashMap<>())
                    .put(
                            frame.terminalId(),
                            new RoomNotice.OutputGap(
                                    frame.terminalId(),
                                    gap == null ? frame.seq() : gap.fromSeq(),
                                    frame.seq()));
        }
    }

    void replay(RoomSessions.Peer peer, long terminalId) {
        replay(peer, terminalId, () -> {});
    }

    void replay(RoomSessions.Peer peer, long terminalId, Runnable afterSync) {
        var stream = streams.get(terminalId);
        peer.replayOutput(
                stream == null ? List.of() : List.copyOf(stream.history),
                sync(terminalId),
                afterSync);
        // The accepted replay and final sync supersede a pending live-delivery gap.
        var peerGaps = gaps.get(peer);
        if (peerGaps != null) {
            peerGaps.remove(terminalId);
            if (peerGaps.isEmpty()) gaps.remove(peer);
        }
    }

    RoomNotice.Sync sync(long terminalId) {
        var stream = streams.get(terminalId);
        return new RoomNotice.Sync(terminalId, stream == null ? 0 : stream.browserSeq);
    }

    long sourceSeq(long terminalId) {
        var stream = streams.get(terminalId);
        return stream == null ? 0 : stream.sourceSeq;
    }

    void acknowledge(long terminalId, long sourceSeq) {
        var stream = streams.computeIfAbsent(terminalId, ignored -> new Stream());
        stream.sourceSeq = Math.max(stream.sourceSeq, sourceSeq);
    }

    void remove(long terminalId) {
        streams.remove(terminalId);
        gaps.values().forEach(gap -> gap.remove(terminalId));
    }
}

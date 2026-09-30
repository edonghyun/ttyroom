package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

class TerminalOutputTests {
    @Test
    void deduplicatesSourceSequencesWhileKeepingBrowserSequencesContiguous() {
        var output = new TerminalOutput();
        var first = output.accept(frame(40, 1));

        var duplicate = output.accept(frame(40, 2));
        var stale = output.accept(frame(39, 3));
        output.acknowledge(7, 50);
        output.acknowledge(7, 45);
        var acknowledged = output.accept(frame(50, 4));
        var next = output.accept(frame(51, 5));

        assertThat(duplicate).isNull();
        assertThat(stale).isNull();
        assertThat(acknowledged).isNull();
        assertThat(first.seq()).isEqualTo(1);
        assertThat(next.seq()).isEqualTo(2);
        assertThat(output.sourceSeq(7)).isEqualTo(51);
        assertThat(output.sync(7)).isEqualTo(new RoomNotice.Sync(7, 2));
    }

    @Test
    void evictsWholeFramesByPayloadBytesAndReplaysTheirOriginalBrowserSequences() {
        var output = new TerminalOutput(3, 10);
        output.accept(frame(1, 1, 2));
        output.accept(frame(2, 3, 4));
        output.accept(frame(3, 5));
        var peer = new Recipient();

        output.replay(peer, 7);

        assertThat(peer.frames).extracting(OutputFrame::seq).containsExactly(2L, 3L);
        assertThat(peer.frames.getFirst().payload()).containsExactly((byte) 3, (byte) 4);
        assertThat(peer.notices).containsExactly(new RoomNotice.Sync(7, 3));
    }

    @Test
    void alsoBoundsEmptyFramesAndDoesNotInventHistoryForAnOversizedFrame() {
        var output = new TerminalOutput(3, 2);
        output.accept(frame(1));
        output.accept(frame(2));
        output.accept(frame(3));
        var emptyHistory = new Recipient();
        output.replay(emptyHistory, 7);

        output.accept(frame(4, 1, 2, 3, 4));
        var oversizedHistory = new Recipient();
        output.replay(oversizedHistory, 7);

        assertThat(emptyHistory.frames).extracting(OutputFrame::seq).containsExactly(2L, 3L);
        assertThat(oversizedHistory.frames).isEmpty();
        assertThat(oversizedHistory.notices).containsExactly(new RoomNotice.Sync(7, 4));
    }

    @Test
    void gapBelongsToTheSlowRecipientAndIsClearedOnlyAfterAcceptance() {
        var output = new TerminalOutput();
        var slow = new Recipient();
        var fast = new Recipient();
        slow.accepting = false;
        for (int seq = 1; seq <= 2; seq++) {
            var frame = output.accept(frame(seq, seq));
            output.deliver(slow, frame);
            output.deliver(fast, frame);
        }

        slow.accepting = true;
        var resumed = output.accept(frame(3, 3));
        output.deliver(slow, resumed);
        output.deliver(slow, output.accept(frame(4, 4)));

        assertThat(fast.gaps).isEmpty();
        assertThat(fast.frames).extracting(OutputFrame::seq).containsExactly(1L, 2L);
        assertThat(slow.gaps).containsExactly(new RoomNotice.OutputGap(7, 1, 2));
        assertThat(slow.frames).extracting(OutputFrame::seq).containsExactly(3L, 4L);
    }

    @Test
    void failedReplayDoesNotSendASuccessSync() {
        var output = new TerminalOutput();
        output.accept(frame(1, 1));
        var peer = new Recipient();
        peer.accepting = false;

        var failure = catchThrowable(() -> output.replay(peer, 7));

        assertThat(failure).isInstanceOf(RoomSessions.PeerUnavailable.class);
        assertThat(peer.notices).isEmpty();
    }

    @Test
    void removedTerminalLosesBothHistoryAndRecipientGaps() {
        var output = new TerminalOutput();
        var peer = new Recipient();
        peer.accepting = false;
        output.deliver(peer, output.accept(frame(40, 1)));

        output.remove(7);
        peer.accepting = true;
        output.deliver(peer, output.accept(frame(1, 9)));
        output.replay(peer, 7);

        assertThat(output.sourceSeq(7)).isEqualTo(1);
        assertThat(peer.gaps).isEmpty();
        assertThat(peer.frames).extracting(OutputFrame::seq).containsExactly(1L, 1L);
        assertThat(peer.frames).allSatisfy(f -> assertThat(f.payload()).containsExactly((byte) 9));
    }

    @Test
    void retainedPayloadCannotBeChangedByTheProducerOrARecipient() {
        var bytes = new byte[] {1, 2};
        var incoming = new OutputFrame(7, 1, bytes);
        var output = new TerminalOutput();
        var accepted = output.accept(incoming);

        bytes[0] = 9;
        accepted.payload()[1] = 9;
        var peer = new Recipient();
        output.replay(peer, 7);

        assertThat(peer.frames.getFirst().payload()).containsExactly((byte) 1, (byte) 2);
    }

    @Test
    void acceptedResyncSupersedesThePendingGapBeforeSubsequentLiveOutput() {
        var output = new TerminalOutput();
        var peer = new Recipient();
        peer.accepting = false;
        output.deliver(peer, output.accept(frame(1, 1)));

        peer.accepting = true;
        output.replay(peer, 7);
        output.deliver(peer, output.accept(frame(2, 2)));

        assertThat(peer.gaps).isEmpty();
        assertThat(peer.frames).extracting(OutputFrame::seq).containsExactly(1L, 2L);
        assertThat(peer.notices).containsExactly(new RoomNotice.Sync(7, 1));
    }

    private static OutputFrame frame(long seq, int... values) {
        var bytes = new byte[values.length];
        for (int i = 0; i < values.length; i++) bytes[i] = (byte) values[i];
        return new OutputFrame(7, seq, bytes);
    }

    private static final class Recipient implements RoomSessions.Peer {
        final List<OutputFrame> frames = new ArrayList<>();
        final List<RoomNotice.OutputGap> gaps = new ArrayList<>();
        final List<RoomNotice> notices = new ArrayList<>();
        boolean accepting = true;

        public void sendInput(InputFrame frame) {
            throw new AssertionError("Unexpected input");
        }

        public void send(RoomNotice notice) {
            notices.add(notice);
        }

        public void replayOutput(
                List<OutputFrame> frames, RoomNotice.Sync boundary, Runnable afterSync) {
            if (!accepting) throw new RoomSessions.PeerUnavailable("Replay budget exhausted");
            this.frames.addAll(frames);
            notices.add(boundary);
            afterSync.run();
        }

        public boolean offerOutput(OutputFrame frame, RoomNotice.OutputGap gap) {
            if (!accepting) return false;
            if (gap != null) gaps.add(gap);
            frames.add(frame);
            return true;
        }

        public void close() {}
    }
}

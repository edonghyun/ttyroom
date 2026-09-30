package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;

import java.nio.ByteBuffer;

class IncomingMessagesTests {
    @Test
    void textWaitsForTheFinalPartAndResetsForTheNextMessage() {
        var incoming = new IncomingMessages(20, 20);

        var pending = incoming.receive(new TextMessage("hello ", false));
        var complete = incoming.receive(new TextMessage("world", true));
        var next = incoming.receive(new TextMessage("next"));

        assertThat(pending).isNull();
        assertThat(complete.getPayload()).isEqualTo("hello world");
        assertThat(next.getPayload()).isEqualTo("next");
    }

    @Test
    void aSurrogatePairSplitAcrossCallbacksIsPreserved() {
        var incoming = new IncomingMessages(2, 2);

        incoming.receive(new TextMessage("\uD83D", false));
        var complete = incoming.receive(new TextMessage("\uDE80", true));

        assertThat(complete.getPayload()).isEqualTo("🚀");
    }

    @Test
    void textCharacterCeilingIncludesAllBufferedPartsAndDiscardsOverflow() {
        var incoming = new IncomingMessages(5, 20);
        incoming.receive(new TextMessage("12345", false));

        var failure = catchThrowable(() -> incoming.receive(new TextMessage("6", false)));
        var late = incoming.receive(new TextMessage("late"));

        assertThat(failure).isInstanceOf(IncomingMessages.TooLarge.class);
        assertThat(late).isNull();
    }

    @Test
    void binaryPartsCopyOnlyTheRemainingBytesWithoutConsumingTheSource() {
        var incoming = new IncomingMessages(20, 4);
        var source = ByteBuffer.wrap(new byte[] {0, 1, 2, 0});
        source.position(1).limit(3);

        var pending = incoming.receive(new BinaryMessage(source, false));
        source.put(1, (byte) 9);
        var complete = incoming.receive(new BinaryMessage(new byte[] {3, 4}, true));
        var next = incoming.receive(new BinaryMessage(new byte[] {5}));

        assertThat(pending).isNull();
        assertThat(source.position()).isEqualTo(1);
        assertThat(complete.getPayload().array()).containsExactly(1, 2, 3, 4);
        assertThat(next.getPayload().array()).containsExactly(5);
    }

    @Test
    void binaryCeilingIncludesAllPartsAndRejectsBeforeTheFinalPart() {
        var incoming = new IncomingMessages(20, 4);
        incoming.receive(new BinaryMessage(new byte[] {1, 2, 3}, false));

        var failure =
                catchThrowable(() -> incoming.receive(new BinaryMessage(new byte[] {4, 5}, false)));
        var late = incoming.receive(new BinaryMessage(new byte[] {6}));

        assertThat(failure).isInstanceOf(IncomingMessages.TooLarge.class);
        assertThat(late).isNull();
    }

    @Test
    void unfragmentedBinaryCannotBypassTheCeiling() {
        var incoming = new IncomingMessages(20, 4);

        var failure = catchThrowable(() -> incoming.receive(new BinaryMessage(new byte[5])));

        assertThat(failure).isInstanceOf(IncomingMessages.TooLarge.class);
    }

    @Test
    void closingDiscardsPartialMessagesAndIgnoresLateCallbacks() {
        var incoming = new IncomingMessages(20, 20);
        incoming.receive(new TextMessage("unfinished", false));
        incoming.receive(new BinaryMessage(new byte[] {1}, false));

        incoming.close();
        var lateText = incoming.receive(new TextMessage("end"));
        var lateBinary = incoming.receive(new BinaryMessage(new byte[] {2}));

        assertThat(lateText).isNull();
        assertThat(lateBinary).isNull();
    }
}

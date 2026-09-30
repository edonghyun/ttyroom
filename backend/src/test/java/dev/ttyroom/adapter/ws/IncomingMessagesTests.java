package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

class IncomingMessagesTests {
    @Test
    void textWaitsForTheFinalPartAndResetsForTheNextMessage() {
        var incoming = incoming(20, 20);

        var pending = incoming.receive(new TextMessage("hello ", false));
        var complete = incoming.receive(new TextMessage("world", true));
        var next = incoming.receive(new TextMessage("next"));

        assertThat(pending).isNull();
        assertThat(complete.getPayload()).isEqualTo("hello world");
        assertThat(next.getPayload()).isEqualTo("next");
    }

    @Test
    void aSurrogatePairSplitAcrossCallbacksIsPreserved() {
        var incoming = incoming(4, 2);

        incoming.receive(new TextMessage("\uD83D", false));
        var complete = incoming.receive(new TextMessage("\uDE80", true));

        assertThat(complete.getPayload()).isEqualTo("🚀");
    }

    @Test
    void textByteCeilingIncludesAllBufferedPartsAndDiscardsOverflow() {
        var incoming = incoming(5, 20);
        incoming.receive(new TextMessage("12345", false));

        var failure = catchThrowable(() -> incoming.receive(new TextMessage("6", false)));
        var late = incoming.receive(new TextMessage("late"));

        assertThat(failure).isInstanceOf(IncomingMessages.TooLarge.class);
        assertThat(late).isNull();
    }

    @Test
    void incompleteTextIsBoundedByUtf8BytesBeforeItCanBeDispatched() {
        var incoming = incoming(5, 20);
        incoming.receive(new TextMessage("가", false));

        var failure = catchThrowable(() -> incoming.receive(new TextMessage("나", false)));
        var late = incoming.receive(new TextMessage("end"));

        assertThat(failure).isInstanceOf(IncomingMessages.TooLarge.class);
        assertThat(late).isNull();
    }

    @Test
    void binaryPartsCopyOnlyTheRemainingBytesWithoutConsumingTheSource() {
        var incoming = incoming(20, 4);
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
        var incoming = incoming(20, 4);
        incoming.receive(new BinaryMessage(new byte[] {1, 2, 3}, false));

        var failure =
                catchThrowable(() -> incoming.receive(new BinaryMessage(new byte[] {4, 5}, false)));
        var late = incoming.receive(new BinaryMessage(new byte[] {6}));

        assertThat(failure).isInstanceOf(IncomingMessages.TooLarge.class);
        assertThat(late).isNull();
    }

    @Test
    void unfragmentedBinaryCannotBypassTheCeiling() {
        var incoming = incoming(20, 4);

        var failure = catchThrowable(() -> incoming.receive(new BinaryMessage(new byte[5])));

        assertThat(failure).isInstanceOf(IncomingMessages.TooLarge.class);
    }

    @Test
    void closingDiscardsPartialMessagesAndIgnoresLateCallbacks() {
        var incoming = incoming(20, 20);
        incoming.receive(new TextMessage("unfinished", false));
        incoming.receive(new BinaryMessage(new byte[] {1}, false));

        incoming.close();
        var lateText = incoming.receive(new TextMessage("end"));
        var lateBinary = incoming.receive(new BinaryMessage(new byte[] {2}));

        assertThat(lateText).isNull();
        assertThat(lateBinary).isNull();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void incompleteMessagesExpireFromTheirFirstPartWithoutExtendingOnProgress(boolean binary) {
        var time = new ManualDeadlines();
        var incoming = time.incoming(20, 20);
        if (binary) {
            incoming.receive(new BinaryMessage(new byte[] {1}, false));
            incoming.receive(new BinaryMessage(new byte[] {2}, false));
        } else {
            incoming.receive(new TextMessage("start", false));
            incoming.receive(new TextMessage("progress", false));
        }

        time.fire(0);
        time.fire(0);
        var late = incoming.receive(new TextMessage("end"));

        assertThat(time.delays).containsExactly(5L);
        assertThat(time.expirations).isEqualTo(1);
        assertThat(late).isNull();
    }

    @Test
    void aCancelledDeadlineCannotExpireTheNextMessage() {
        var time = new ManualDeadlines();
        var incoming = time.incoming(20, 20);
        incoming.receive(new TextMessage("first", false));
        incoming.receive(new TextMessage(" done"));
        incoming.receive(new TextMessage("second", false));

        time.fire(0);
        var completed = incoming.receive(new TextMessage(" done"));
        time.fire(1);

        assertThat(completed.getPayload()).isEqualTo("second done");
        assertThat(time.expirations).isZero();
        time.futures.forEach(future -> verify(future).cancel(false));
    }

    @Test
    void closingCancelsTheDeadlineAndLateTimersDoNotNotifyAgain() {
        var time = new ManualDeadlines();
        var incoming = time.incoming(20, 20);
        incoming.receive(new BinaryMessage(new byte[] {1}, false));

        incoming.close();
        time.fire(0);

        assertThat(time.expirations).isZero();
        verify(time.futures.getFirst()).cancel(false);
    }

    @ParameterizedTest
    @ValueSource(strings = {"ASCII", "가나다", "éé", "🚀", "\uD83D!", "\uDE80", "\uD83D\uD83D"})
    void byteAccountingMatchesUtf8AcrossEverySplit(String text) {
        int bytes = text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        for (int split = 0; split <= text.length(); split++) {
            var incoming = incoming(bytes, 20);
            incoming.receive(new TextMessage(text.substring(0, split), false));

            var complete = incoming.receive(new TextMessage(text.substring(split)));
            var overflow =
                    catchThrowable(() -> incoming(bytes - 1, 20).receive(new TextMessage(text)));

            assertThat(complete.getPayload()).isEqualTo(text);
            assertThat(overflow).isInstanceOf(IncomingMessages.TooLarge.class);
        }
    }

    private static IncomingMessages incoming(int textBytes, int binaryBytes) {
        return new ManualDeadlines().incoming(textBytes, binaryBytes);
    }

    private static final class ManualDeadlines {
        final ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        final ArrayList<Runnable> tasks = new ArrayList<>();
        final ArrayList<ScheduledFuture<?>> futures = new ArrayList<>();
        final ArrayList<Long> delays = new ArrayList<>();
        int expirations;

        ManualDeadlines() {
            when(scheduler.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.SECONDS)))
                    .thenAnswer(
                            call -> {
                                tasks.add(call.getArgument(0));
                                delays.add(call.getArgument(1));
                                var future = mock(ScheduledFuture.class);
                                futures.add(future);
                                return future;
                            });
        }

        IncomingMessages incoming(int textBytes, int binaryBytes) {
            return new IncomingMessages(textBytes, binaryBytes, scheduler, () -> expirations++);
        }

        // Deliberately run cancelled tasks too: cancellation cannot recall a callback already
        // dispatched.
        void fire(int index) {
            tasks.get(index).run();
        }
    }
}

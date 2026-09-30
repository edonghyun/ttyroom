package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.OutputFrame;
import dev.ttyroom.application.RoomSessions.PeerUnavailable;

import jdk.jfr.Recording;
import jdk.jfr.consumer.RecordingFile;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;

@Timeout(10)
class SocketSenderTests {
    @Test
    void acceptedMessagesDrainInOrderBeforeTheCloseFrame() throws Exception {
        try (var peer = new Fixture()) {
            peer.blockWrites();
            peer.send("welcome");
            peer.awaitWrite();

            peer.send("joined");
            peer.sender.finish(CloseStatus.NORMAL);
            var failure = catchThrowable(() -> peer.send("too late"));
            peer.release.countDown();
            peer.awaitClose();

            assertThat(peer.delivered).containsExactly("welcome", "joined", "<close>");
            assertThat(peer.closeStatus).isEqualTo(CloseStatus.NORMAL);
            assertThat(failure).isInstanceOf(PeerUnavailable.class);
            assertThat(peer.disconnects.get()).isEqualTo(1);
        }
    }

    @Test
    void byteLimitCountsUtf8AndTheInFlightMessage() throws Exception {
        try (var peer = new Fixture(new SocketSender.Limits(6, 10, Duration.ofSeconds(3)))) {
            peer.blockWrites();
            peer.send("가");
            peer.awaitWrite();
            peer.send("나");

            var failure = catchThrowable(() -> peer.send("다"));
            peer.awaitClose();

            assertThat(failure).isInstanceOf(PeerUnavailable.class);
            assertThat(peer.closeStatus.getCode()).isEqualTo(1008);
            assertThat(peer.delivered).doesNotContain("나", "다");
            assertThat(peer.disconnects.get()).isEqualTo(1);
        }
    }

    @Test
    void messageLimitAlsoBoundsEmptyMessages() throws Exception {
        try (var peer = new Fixture(new SocketSender.Limits(100, 2, Duration.ofSeconds(3)))) {
            peer.blockWrites();
            peer.send("");
            peer.awaitWrite();
            peer.send("");

            var failure = catchThrowable(() -> peer.send(""));
            peer.awaitClose();

            assertThat(failure).isInstanceOf(PeerUnavailable.class);
            assertThat(peer.closeStatus.getCode()).isEqualTo(1008);
        }
    }

    @Test
    void aStuckWriteExpiresWithoutAnotherMessageArriving() throws Exception {
        try (var peer = new Fixture(new SocketSender.Limits(100, 10, Duration.ofMillis(100)))) {
            peer.blockWrites();

            peer.send("welcome");
            peer.awaitClose();

            assertThat(peer.closeStatus.getCode()).isEqualTo(1011);
            assertThat(peer.closeStatus.getReason()).isEqualTo("outbound write timeout");
            assertThat(peer.disconnects.get()).isEqualTo(1);
        }
    }

    @Test
    void aFailedWriteDisconnectsOnceAndRejectsFutureMessages() throws Exception {
        try (var peer = new Fixture()) {
            doThrow(new IOException("disconnected")).when(peer.socket).sendMessage(any());

            peer.send("welcome");
            peer.awaitClose();
            peer.sender.abort(CloseStatus.NORMAL);
            var failure = catchThrowable(() -> peer.send("joined"));

            assertThat(peer.disconnects.get()).isEqualTo(1);
            assertThat(peer.closeStatus.getCode()).isEqualTo(1011);
            assertThat(failure).isInstanceOf(PeerUnavailable.class);
        }
    }

    @Test
    void abortDiscardsTheQueueAndDoesNotWaitForSocketClose() throws Exception {
        try (var peer = new Fixture()) {
            var closing = new CountDownLatch(1);
            var releaseClose = new CountDownLatch(1);
            doAnswer(
                            call -> {
                                closing.countDown();
                                await(releaseClose, "close release");
                                peer.closed.countDown();
                                return null;
                            })
                    .when(peer.socket)
                    .close(any());
            peer.blockWrites();
            peer.send("welcome");
            peer.awaitWrite();
            peer.send("queued");

            try {
                peer.sender.abort(CloseStatus.GOING_AWAY);
                await(closing, "socket close");
                var failure = catchThrowable(() -> peer.send("late"));

                assertThat(peer.disconnects.get()).isEqualTo(1);
                assertThat(peer.delivered).doesNotContain("queued");
                assertThat(failure).isInstanceOf(PeerUnavailable.class);
            } finally {
                releaseClose.countDown();
            }
        }
    }

    @Test
    void anAlreadyRunningOldDeadlineCannotCloseTheNextWrite() throws Exception {
        try (var peer = new Fixture()) {
            var writes = new AtomicInteger();
            doAnswer(
                            call -> {
                                if (writes.incrementAndGet() == 2) {
                                    peer.writing.countDown();
                                    await(peer.release, "second write release");
                                }
                                peer.record(call.getArgument(0));
                                return null;
                            })
                    .when(peer.socket)
                    .sendMessage(any());
            var message = new TextMessage("reused");
            peer.sender.send(message);
            peer.sender.send(message);
            peer.awaitWrite();

            peer.deadlines.callbacks.getFirst().run();
            peer.sender.finish(CloseStatus.NORMAL);
            peer.release.countDown();
            peer.awaitClose();

            assertThat(peer.delivered).containsExactly("reused", "reused", "<close>");
            assertThat(peer.closeStatus).isEqualTo(CloseStatus.NORMAL);
        }
    }

    @Test
    void rejectedOutputBatchEnqueuesNeitherMarkersNorPayloadAndKeepsThePeerUsable()
            throws Exception {
        try (var peer = new Fixture(new SocketSender.Limits(100, 3, Duration.ofSeconds(3)))) {
            peer.blockWrites();
            peer.send("in flight");
            peer.awaitWrite();

            var accepted =
                    peer.sender.offer(
                            List.of(
                                    new TextMessage("sync"),
                                    new TextMessage("gap"),
                                    new BinaryMessage(new byte[] {1})));
            peer.send("still usable");
            peer.sender.finish(CloseStatus.NORMAL);
            peer.release.countDown();
            peer.awaitClose();

            assertThat(accepted).isFalse();
            assertThat(peer.delivered).containsExactly("in flight", "still usable", "<close>");
            assertThat(peer.closeStatus).isEqualTo(CloseStatus.NORMAL);
        }
    }

    @Test
    void recordingADroppedOutputDoesNotConsumeControlCapacity(@TempDir Path directory)
            throws Exception {
        try (var recording = new Recording();
                var peer = new Fixture()) {
            recording.enable("ttyroom.BufferPressure");
            recording.start();
            peer.blockWrites();
            peer.send("hold");
            peer.awaitWrite();

            var accepted = peer.sender.offerOutput(List.of(new TextMessage("output")), 4);
            peer.send("control");
            peer.sender.finish(CloseStatus.NORMAL);
            peer.release.countDown();
            peer.awaitClose();
            recording.stop();
            var file = directory.resolve("pressure.jfr");
            recording.dump(file);
            var events =
                    RecordingFile.readAllEvents(file).stream()
                            .filter(
                                    event ->
                                            event.getEventType()
                                                    .getName()
                                                    .equals("ttyroom.BufferPressure"))
                            .toList();

            assertThat(accepted).isFalse();
            assertThat(peer.delivered).containsExactly("hold", "control", "<close>");
            assertThat(events).hasSize(1);
            assertThat(events.getFirst().getString("outcome")).isEqualTo("live-drop");
            assertThat(events.getFirst().getLong("pendingBytes")).isEqualTo(4);
        }
    }

    @Test
    void acceptedMixedBatchKeepsSyncGapAndBinaryOrdering() throws Exception {
        try (var peer = new Fixture()) {
            var messages = new CopyOnWriteArrayList<WebSocketMessage<?>>();
            doAnswer(
                            call -> {
                                messages.add(call.getArgument(0));
                                return null;
                            })
                    .when(peer.socket)
                    .sendMessage(any());
            var sync = new TextMessage("sync");
            var gap = new TextMessage("gap");
            var output = new BinaryMessage(new byte[] {1, 2, 3});

            var accepted = peer.sender.offer(List.of(sync, gap, output));
            peer.sender.finish(CloseStatus.NORMAL);
            peer.awaitClose();

            assertThat(accepted).isTrue();
            assertThat(messages).containsExactly(sync, gap, output);
        }
    }

    @Test
    void replayIsAnImmutableFifoReservationThatDrainsBeforeLaterLiveOutput() throws Exception {
        try (var peer = new Fixture()) {
            peer.blockWrites();
            peer.send("welcome");
            peer.awaitWrite();
            var history = new ArrayList<>(frames(1024, 1));

            peer.sender.replay(history, new TextMessage("sync"));
            history.clear();
            peer.send("after replay");
            peer.sender.send(
                    new BinaryMessage(OutputWire.encode(new OutputFrame(7, 1025, new byte[] {1}))));
            peer.sender.finish(CloseStatus.NORMAL);
            peer.release.countDown();
            peer.awaitClose();

            var expected = new ArrayList<String>();
            expected.add("welcome");
            IntStream.rangeClosed(1, 1024).forEach(seq -> expected.add("output:" + seq));
            expected.addAll(List.of("sync", "after replay", "output:1025", "<close>"));
            assertThat(peer.delivered).containsExactlyElementsOf(expected);
            assertThat(peer.closeStatus).isEqualTo(CloseStatus.NORMAL);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"bytes", "frames", "requests"})
    void accumulatedReplayReservationsHaveIndependentHardLimits(String limit) throws Exception {
        try (var peer = new Fixture()) {
            peer.blockWrites();
            peer.send("welcome");
            peer.awaitWrite();
            List<OutputFrame> history =
                    switch (limit) {
                        case "bytes" -> frames(1, 1_048_576);
                        case "frames" ->
                                Collections.nCopies(16_384, new OutputFrame(7, 1, new byte[0]));
                        default -> List.of();
                    };
            int accepted =
                    switch (limit) {
                        case "bytes" -> 3;
                        case "frames" -> 4;
                        default -> 16;
                    };
            for (int i = 0; i < accepted; i++) peer.sender.replay(history, new TextMessage("sync"));

            var failure =
                    catchThrowable(() -> peer.sender.replay(history, new TextMessage("sync")));
            peer.awaitClose();

            assertThat(failure).isInstanceOf(PeerUnavailable.class);
            assertThat(peer.closeStatus.getCode()).isEqualTo(1008);
            assertThat(peer.closeStatus.getReason()).isEqualTo("outbound replay limit");
            assertThat(peer.delivered).doesNotContain("sync", "output:1");
            assertThat(peer.disconnects.get()).isEqualTo(1);
        }
    }

    @Test
    void aReplayBudgetRemainsReservedWhileItsFinalSyncIsInFlight() throws Exception {
        try (var peer = new Fixture()) {
            doAnswer(
                            call -> {
                                WebSocketMessage<?> message = call.getArgument(0);
                                if (message instanceof TextMessage) {
                                    peer.writing.countDown();
                                    await(peer.release, "sync release");
                                }
                                return null;
                            })
                    .when(peer.socket)
                    .sendMessage(any());
            var history = frames(1, 3 * 1_048_576);
            peer.sender.replay(history, new TextMessage("sync"));
            peer.awaitWrite();

            var failure =
                    catchThrowable(
                            () -> peer.sender.replay(history, new TextMessage("another sync")));
            peer.awaitClose();

            assertThat(failure).isInstanceOf(PeerUnavailable.class);
            assertThat(peer.closeStatus.getReason()).isEqualTo("outbound replay limit");
        }
    }

    @Test
    void completedReplayReleasesCapacityForTheNextRequest() throws Exception {
        try (var peer = new Fixture()) {
            var history = frames(1, 3 * 1_048_576);
            var afterReplay = new CountDownLatch(1);
            doAnswer(
                            call -> {
                                if (call.getArgument(0) instanceof TextMessage text
                                        && text.getPayload().equals("barrier"))
                                    afterReplay.countDown();
                                peer.record(call.getArgument(0));
                                return null;
                            })
                    .when(peer.socket)
                    .sendMessage(any());
            peer.sender.replay(history, new TextMessage("first sync"));
            peer.send("barrier");
            await(afterReplay, "first replay completion");

            peer.sender.replay(history, new TextMessage("second sync"));
            peer.sender.finish(CloseStatus.NORMAL);
            peer.awaitClose();

            assertThat(peer.delivered)
                    .containsExactly(
                            "output:1",
                            "first sync",
                            "barrier",
                            "output:1",
                            "second sync",
                            "<close>");
            assertThat(peer.closeStatus).isEqualTo(CloseStatus.NORMAL);
        }
    }

    @Test
    void aStuckReplayWriteExpiresAndDoesNotSendItsRemainingFramesOrSync() throws Exception {
        try (var peer = new Fixture(new SocketSender.Limits(100, 10, Duration.ofMillis(100)))) {
            peer.blockWrites();

            peer.sender.replay(frames(2, 1), new TextMessage("sync"));
            peer.awaitClose();

            assertThat(peer.closeStatus.getCode()).isEqualTo(1011);
            assertThat(peer.delivered).doesNotContain("output:2", "sync");
            assertThat(peer.disconnects.get()).isEqualTo(1);
        }
    }

    @Test
    void abortDuringReplayDiscardsTheRemainderAndRejectsNewReservations() throws Exception {
        try (var peer = new Fixture()) {
            peer.blockWrites();
            peer.sender.replay(frames(2, 1), new TextMessage("sync"));
            peer.awaitWrite();

            peer.sender.abort(CloseStatus.GOING_AWAY);
            peer.awaitClose();
            var failure =
                    catchThrowable(
                            () -> peer.sender.replay(frames(1, 1), new TextMessage("late sync")));

            assertThat(peer.delivered).doesNotContain("output:2", "sync", "late sync");
            assertThat(failure).isInstanceOf(PeerUnavailable.class);
            assertThat(peer.closeStatus).isEqualTo(CloseStatus.GOING_AWAY);
            assertThat(peer.disconnects.get()).isEqualTo(1);
        }
    }

    @Test
    void liveDropThresholdCountsAnInflightWriteAndStillAllowsControl() throws Exception {
        try (var peer = new Fixture()) {
            peer.blockWrites();
            peer.send("abc");
            peer.awaitWrite();

            var accepted = peer.sender.offerOutput(List.of(new TextMessage("live")), 3);
            peer.send("control");
            peer.sender.finish(CloseStatus.NORMAL);
            peer.release.countDown();
            peer.awaitClose();

            assertThat(accepted).isFalse();
            assertThat(peer.delivered).containsExactly("abc", "control", "<close>");
        }
    }

    @Test
    void liveOutputIsAcceptedBelowTheThreshold() throws Exception {
        try (var peer = new Fixture()) {
            peer.blockWrites();
            peer.send("abc");
            peer.awaitWrite();

            var accepted = peer.sender.offerOutput(List.of(new TextMessage("live")), 4);
            peer.sender.finish(CloseStatus.NORMAL);
            peer.release.countDown();
            peer.awaitClose();

            assertThat(accepted).isTrue();
            assertThat(peer.delivered).containsExactly("abc", "live", "<close>");
        }
    }

    private static List<OutputFrame> frames(int count, int bytes) {
        return IntStream.rangeClosed(1, count)
                .mapToObj(seq -> new OutputFrame(7, seq, new byte[bytes]))
                .toList();
    }

    private static final class RecordingDeadlines extends ScheduledThreadPoolExecutor {
        final List<Runnable> callbacks = new CopyOnWriteArrayList<>();

        RecordingDeadlines() {
            super(1);
            setRemoveOnCancelPolicy(true);
        }

        @Override
        public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            callbacks.add(command);
            return super.schedule(command, delay, unit);
        }
    }

    private static void await(CountDownLatch latch, String operation) throws InterruptedException {
        if (!latch.await(3, TimeUnit.SECONDS))
            throw new AssertionError("Timed out awaiting " + operation);
    }

    private static final class Fixture implements AutoCloseable {
        final WebSocketSession socket = mock(WebSocketSession.class);
        final RecordingDeadlines deadlines = new RecordingDeadlines();
        final AtomicInteger disconnects = new AtomicInteger();
        final CountDownLatch writing = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final CountDownLatch closed = new CountDownLatch(1);
        final List<String> delivered = new CopyOnWriteArrayList<>();
        final SocketSender sender;
        volatile CloseStatus closeStatus;

        Fixture() throws Exception {
            this(new SocketSender.Limits(1024, 10, Duration.ofSeconds(3)));
        }

        Fixture(SocketSender.Limits limits) throws Exception {
            when(socket.isOpen()).thenReturn(true);
            doAnswer(
                            call -> {
                                record(call.getArgument(0));
                                return null;
                            })
                    .when(socket)
                    .sendMessage(any());
            doAnswer(
                            call -> {
                                closeStatus = call.getArgument(0);
                                delivered.add("<close>");
                                closed.countDown();
                                return null;
                            })
                    .when(socket)
                    .close(any());
            sender = new SocketSender(socket, deadlines, disconnects::incrementAndGet, limits);
        }

        void record(WebSocketMessage<?> message) {
            delivered.add(
                    message instanceof TextMessage text
                            ? text.getPayload()
                            : "output:"
                                    + OutputWire.decode(((BinaryMessage) message).getPayload())
                                            .seq());
        }

        void send(String text) {
            sender.send(new TextMessage(text));
        }

        void blockWrites() throws Exception {
            doAnswer(
                            call -> {
                                writing.countDown();
                                await(release, "write release");
                                record(call.getArgument(0));
                                return null;
                            })
                    .when(socket)
                    .sendMessage(any());
        }

        void awaitWrite() throws Exception {
            await(writing, "write start");
        }

        void awaitClose() throws Exception {
            await(closed, "socket close");
        }

        @Override
        public void close() throws Exception {
            sender.abort(CloseStatus.GOING_AWAY);
            release.countDown();
            awaitClose();
            deadlines.shutdownNow();
        }
    }
}

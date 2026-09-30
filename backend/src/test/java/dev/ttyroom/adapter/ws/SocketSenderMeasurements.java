package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.OutputFrame;
import dev.ttyroom.application.RoomSessions.PeerUnavailable;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;

/** Controlled adapter observations, not network throughput or a microbenchmark. */
@Tag("performance")
@Timeout(60)
class SocketSenderMeasurements {
    @Test
    void blockedRecipientBoundsTheControlQueue() throws Exception {
        var result = new LinkedHashMap<String, Object>();
        result.put("completed", false);
        try (var peer = new BlockedTransport()) {
            peer.blockFirstWrite();
            var before = heapUsed();
            long started = System.nanoTime();

            for (int i = 1; i < 256; i++) peer.sender.send(new TextMessage("control"));
            var reserved = heapUsed();
            var failure = catchThrowable(() -> peer.sender.send(new TextMessage("overflow")));
            peer.awaitClose();
            result.put("enqueueAndRejectMs", elapsed(started));
            result.put("heapBeforeBytes", before);
            result.put("heapReservedBytes", reserved);
            result.put("closeCode", peer.status.getCode());
            result.put("acceptedIncludingInflight", 256);
            result.put("transportWrites", peer.writes.get());

            assertThat(failure).isInstanceOf(PeerUnavailable.class);
            assertThat(peer.status.getCode()).isEqualTo(1008);
            assertThat(peer.writes.get()).isEqualTo(1);
            result.put("completed", true);
        } finally {
            save("control-queue", result);
        }
    }

    @Test
    void slowRecipientDropsLiveOutputButDrainsAcceptedControl() throws Exception {
        var result = new LinkedHashMap<String, Object>();
        result.put("completed", false);
        try (var peer = new BlockedTransport()) {
            peer.blockFirstWrite(); // 1024 bytes remain in flight until explicit release.
            int accepted = 0;
            var payload = List.of(new TextMessage("x".repeat(1024)));
            long started = System.nanoTime();

            while (accepted < 256 && peer.sender.offerOutput(payload, 65_536)) accepted++;
            var reserved = heapUsed();
            peer.sender.send(new TextMessage("control"));
            peer.drain();
            result.put("enqueueAndDrainMs", elapsed(started));
            result.put("acceptedLiveFrames", accepted);
            result.put("firstDroppedFrame", accepted + 1);
            result.put("dropThresholdBytes", 65_536);
            result.put("heapReservedBytes", reserved);
            result.put("heapAfterDrainBytes", heapUsed());
            result.put("transportWrites", peer.writes.get());

            assertThat(accepted).isEqualTo(63);
            assertThat(peer.writes.get()).isEqualTo(65); // blocker + output + control
            assertThat(peer.status).isEqualTo(CloseStatus.NORMAL);
            result.put("completed", true);
        } finally {
            save("slow-recipient", result);
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {65_536, 1_048_576})
    void replayReservationAndDrainAtFixedPayloadSizes(int bytes) throws Exception {
        var samples = new ArrayList<Map<String, Object>>();
        var result = new LinkedHashMap<String, Object>();
        result.put("completed", false);
        result.put("payloadBytes", bytes);
        result.put("framePayloadBytes", 1024);
        result.put("samples", samples);
        try {
            for (int trial = 0; trial < 25; trial++) {
                var sample = new LinkedHashMap<String, Object>();
                sample.put("warmup", trial < 5);
                sample.put("completed", false);
                samples.add(sample);
                // Distinct frames model retained history; construction is outside the timer.
                var frames =
                        IntStream.rangeClosed(1, bytes / 1024)
                                .mapToObj(seq -> new OutputFrame(7, seq, new byte[1024]))
                                .toList();
                try (var peer = new BlockedTransport()) {
                    peer.blockFirstWrite();
                    sample.put("heapBeforeBytes", heapUsed());
                    long started = System.nanoTime();

                    peer.sender.replay(frames, new TextMessage("sync"));
                    sample.put("reserveMs", elapsed(started));
                    sample.put("heapReservedBytes", heapUsed());
                    started = System.nanoTime();
                    peer.drain();
                    sample.put("drainMs", elapsed(started));
                    sample.put("heapAfterDrainBytes", heapUsed());
                    sample.put("transportWrites", peer.writes.get());

                    assertThat(peer.writes.get()).isEqualTo(frames.size() + 2);
                    assertThat(peer.status).isEqualTo(CloseStatus.NORMAL);
                    sample.put("completed", true);
                }
            }
            result.put("completed", true);
        } finally {
            save("replay-" + bytes, result);
        }
    }

    private static long heapUsed() {
        return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
    }

    private static double elapsed(long started) {
        return (System.nanoTime() - started) / 1_000_000.0;
    }

    private static void save(String name, Map<String, Object> result) throws Exception {
        String directory = System.getProperty("ttyroom.performance.dir", "");
        if (directory.isBlank()) throw new IllegalArgumentException("performanceDir is required");
        result.put("scope", "SocketSender with latch-blocked fake transport; no network");
        result.put(
                "environment",
                Map.of(
                        "java", System.getProperty("java.runtime.version"),
                        "os",
                                System.getProperty("os.name")
                                        + " "
                                        + System.getProperty("os.version"),
                        "jvmArguments", ManagementFactory.getRuntimeMXBean().getInputArguments(),
                        "logicalCpus", Runtime.getRuntime().availableProcessors()));
        Files.createDirectories(Path.of(directory));
        Files.writeString(
                Path.of(directory, name + ".json"),
                JsonMapper.builder()
                        .build()
                        .writerWithDefaultPrettyPrinter()
                        .writeValueAsString(result));
    }

    private static final class BlockedTransport implements AutoCloseable {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final CountDownLatch closed = new CountDownLatch(1);
        final AtomicInteger writes = new AtomicInteger();
        final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1);
        final SocketSender sender;
        volatile CloseStatus status;

        BlockedTransport() throws Exception {
            deadlines.setRemoveOnCancelPolicy(true);
            var socket = mock(WebSocketSession.class);
            when(socket.isOpen()).thenReturn(true);
            doAnswer(
                            call -> {
                                if (writes.incrementAndGet() == 1) {
                                    entered.countDown();
                                    await(release);
                                }
                                return null;
                            })
                    .when(socket)
                    .sendMessage(any(WebSocketMessage.class));
            doAnswer(
                            call -> {
                                status = call.getArgument(0);
                                closed.countDown();
                                return null;
                            })
                    .when(socket)
                    .close(any());
            sender = new SocketSender(socket, deadlines, () -> {});
        }

        void blockFirstWrite() throws Exception {
            sender.send(new TextMessage("x".repeat(1024)));
            await(entered);
        }

        void drain() throws Exception {
            sender.finish(CloseStatus.NORMAL);
            release.countDown();
            awaitClose();
        }

        void awaitClose() throws Exception {
            await(closed);
        }

        private static void await(CountDownLatch latch) throws InterruptedException {
            if (!latch.await(10, TimeUnit.SECONDS))
                throw new AssertionError("Transport gate timeout");
        }

        public void close() throws Exception {
            release.countDown();
            sender.abort(CloseStatus.GOING_AWAY);
            try {
                awaitClose();
            } finally {
                deadlines.shutdownNow();
                if (!deadlines.awaitTermination(10, TimeUnit.SECONDS))
                    throw new AssertionError("Deadline executor did not stop");
            }
        }
    }
}

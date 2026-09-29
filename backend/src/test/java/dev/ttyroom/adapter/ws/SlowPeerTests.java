package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.OutputFrame;
import dev.ttyroom.application.RoomDirectory;
import dev.ttyroom.application.RoomSessions;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.stream.LongStream;

@Timeout(10)
class SlowPeerTests {
    @Test
    void aBlockedWelcomeDoesNotBlockAnotherParticipantJoiningTheSameRoom() throws Exception {
        try (var room = new Fixture()) {
            var slow = room.peer("slow");
            var bob = room.peer("bob");
            room.blockWrites(slow);
            room.joinAsync(slow);
            room.awaitBlockedWrite();

            room.joinAsync(bob).get(1, TimeUnit.SECONDS);
            var welcome = bob.messages.poll(1, TimeUnit.SECONDS);

            assertThat(welcome).isNotNull();
            assertThat(((TextMessage) welcome).getPayload()).contains("\"type\":\"welcome\"");
        }
    }

    @Test
    void replacingAConnectionDoesNotWaitForItsSocketToClose() throws Exception {
        try (var room = new Fixture()) {
            var old = room.peer("alice");
            var replacement = room.peer("replacement");
            var bob = room.peer("bob");
            room.joinAsync(old).get(1, TimeUnit.SECONDS);
            room.blockClose(old);

            room.joinAsync(replacement, "alice").get(1, TimeUnit.SECONDS);
            room.awaitBlockedWrite();
            room.joinAsync(bob).get(1, TimeUnit.SECONDS);
            var welcome = bob.messages.poll(1, TimeUnit.SECONDS);

            assertThat(welcome).isNotNull();
            assertThat(((TextMessage) welcome).getPayload()).contains("\"type\":\"welcome\"");
        }
    }

    @ParameterizedTest(name = "replay {0} frames of {1} bytes")
    @CsvSource({"1024, 1", "1, 1048576"})
    void aBlockedWelcomeCanDrainLargeHistoryWithoutBlockingAnotherJoin(int count, int bytes)
            throws Exception {
        try (var room = new Fixture()) {
            room.givenHistory(count, bytes);
            var slow = room.peer("slow");
            var bob = room.peer("bob");
            room.blockWrites(slow);
            room.joinAsync(slow).get(1, TimeUnit.SECONDS);
            room.awaitBlockedWrite();

            room.joinAsync(bob).get(1, TimeUnit.SECONDS);
            room.release.countDown();
            var replay = room.readReplay(slow);

            assertThat(replay)
                    .extracting(OutputFrame::seq)
                    .containsExactlyElementsOf(LongStream.rangeClosed(1, count).boxed().toList());
            assertThat(replay).allSatisfy(frame -> assertThat(frame.size()).isEqualTo(bytes));
            verify(slow.socket, never()).close(any());
        }
    }

    private static final class Fixture implements AutoCloseable {
        final RoomDirectory rooms = new RoomDirectory();
        final RoomDirectory.Invitation invitation = rooms.create("test");
        final RoomSessions admission = new RoomSessions(rooms);
        final RoomSocketHandler handler =
                new RoomSocketHandler(
                        admission,
                        JsonMapper.builder().build(),
                        // Admit the 1 MiB history fixture including its wire header; this tests
                        // outbound replay.
                        new RoomSocketHandler.Limits(1_048_576, 1_048_576 + 9));
        final ExecutorService clients = Executors.newVirtualThreadPerTaskExecutor();
        final CountDownLatch writing = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);

        Peer peer(String id) throws Exception {
            var peer = new Peer(id);
            doAnswer(
                            call -> {
                                peer.messages.add(call.getArgument(0));
                                return null;
                            })
                    .when(peer.socket)
                    .sendMessage(any());
            handler.afterConnectionEstablished(peer.socket);
            return peer;
        }

        void givenHistory(int count, int bytes) throws Exception {
            var host = peer("host");
            joinAsync(host, "host", "host").get(1, TimeUnit.SECONDS);
            handler.handleTextMessage(
                    host.socket,
                    new TextMessage(
                            """
                            {"type":"host-inventory","terminals":[{"terminalId":7,"runtimeId":"r7","firstRetainedSeq":0,"lastOutputSeq":0}]}
                            """));
            while (true) {
                var message = host.messages.poll(2, TimeUnit.SECONDS);
                if (message == null) throw new AssertionError("Host recovery did not complete");
                if (message instanceof TextMessage text
                        && text.getPayload().contains("\"type\":\"host-ready\"")) break;
            }
            var payload = new byte[bytes];
            for (int seq = 1; seq <= count; seq++)
                handler.handleBinaryMessage(
                        host.socket,
                        new BinaryMessage(OutputWire.encode(new OutputFrame(7, seq, payload))));
        }

        List<OutputFrame> readReplay(Peer peer) throws Exception {
            var frames = new ArrayList<OutputFrame>();
            for (; ; ) {
                var message = peer.messages.poll(2, TimeUnit.SECONDS);
                if (message == null) throw new AssertionError("Replay did not finish with sync");
                if (message instanceof BinaryMessage binary)
                    frames.add(OutputWire.decode(binary.getPayload()));
                else if (message instanceof TextMessage text
                        && JsonMapper.builder()
                                .build()
                                .readTree(text.getPayload())
                                .get("type")
                                .asString()
                                .equals("sync")) return frames;
            }
        }

        void blockWrites(Peer peer) throws Exception {
            doAnswer(
                            call -> {
                                writing.countDown();
                                if (!release.await(5, TimeUnit.SECONDS))
                                    throw new AssertionError("write was not released");
                                peer.messages.add(call.getArgument(0));
                                return null;
                            })
                    .when(peer.socket)
                    .sendMessage(any());
        }

        void blockClose(Peer peer) throws Exception {
            doAnswer(
                            call -> {
                                writing.countDown();
                                if (!release.await(5, TimeUnit.SECONDS))
                                    throw new AssertionError("close was not released");
                                return null;
                            })
                    .when(peer.socket)
                    .close(any());
        }

        void awaitBlockedWrite() throws Exception {
            if (!writing.await(1, TimeUnit.SECONDS))
                throw new AssertionError("write did not start");
        }

        Future<?> joinAsync(Peer peer) {
            return joinAsync(peer, peer.id);
        }

        Future<?> joinAsync(Peer peer, String clientId) {
            return joinAsync(peer, clientId, "participant");
        }

        Future<?> joinAsync(Peer peer, String clientId, String role) {
            var hello =
                    new TextMessage(
                            """
                            {"type":"hello","protocolVersion":7,"roomId":"%s","token":"%s",
                             "clientId":"%s","name":"%s","role":"%s"}
                            """
                                    .formatted(
                                            invitation.roomId(),
                                            invitation.token(),
                                            clientId,
                                            clientId,
                                            role));
            return clients.submit(() -> handler.handleTextMessage(peer.socket, hello));
        }

        @Override
        public void close() {
            release.countDown();
            clients.close();
            handler.close();
            admission.close();
        }
    }

    private static final class Peer {
        final String id;
        final WebSocketSession socket = mock(WebSocketSession.class);
        final BlockingQueue<WebSocketMessage<?>> messages = new LinkedBlockingQueue<>();

        Peer(String id) {
            this.id = id;
            when(socket.getId()).thenReturn(id);
            when(socket.isOpen()).thenReturn(true);
        }
    }
}

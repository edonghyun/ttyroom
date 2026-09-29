package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.HostCommand;
import dev.ttyroom.application.InputFrame;
import dev.ttyroom.application.RoomDirectory;
import dev.ttyroom.application.RoomSessions;
import dev.ttyroom.application.RoomStore;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

class RoomInputOrderingTests {
    @Test
    void inputUsesTheCommittedLeaseUntilQueuedReleaseCompletes() throws Exception {
        try (var fixture = Fixture.inputEnabledRoom()) {
            var saving = fixture.holdNextSave();

            fixture.renameTerminal("Saved");
            saving.awaitEntered();
            fixture.releaseLease();
            fixture.sendInput(1);
            var forwardedWhileSaving = List.copyOf(fixture.hostInputs);
            saving.release();
            fixture.awaitLeaseReleased();
            fixture.sendInput(2);
            var rejectedAfterRelease = fixture.awaitNotice("lease-invalid");

            assertThat(forwardedWhileSaving)
                    .singleElement()
                    .usingRecursiveComparison()
                    .isEqualTo(fixture.input(1));
            assertThat(rejectedAfterRelease.path("terminalId").asLong()).isEqualTo(7);
            assertThat(rejectedAfterRelease.path("reason").asString()).isEqualTo("not-holder");
            assertThat(fixture.hostInputs).hasSize(1);
            assertThat(
                            fixture.receivedNotices.stream()
                                    .filter(
                                            notice ->
                                                    notice.path("type")
                                                            .asString()
                                                            .equals("lease-invalid"))
                                    .toList())
                    .containsExactly(rejectedAfterRelease);
        }
    }

    /**
     * Real handler, sessions and domain; only socket writes and the storage boundary are doubles.
     */
    private static final class Fixture implements AutoCloseable {
        final RoomStore store = mock(RoomStore.class);
        final RoomDirectory rooms = new RoomDirectory(store);
        final RoomSessions sessions = new RoomSessions(rooms);
        final JsonMapper json = JsonMapper.builder().build();
        final RoomSocketHandler handler = new RoomSocketHandler(sessions, json);
        final WebSocketSession alice = mock(WebSocketSession.class);
        final List<InputFrame> hostInputs = new CopyOnWriteArrayList<>();
        final List<JsonNode> receivedNotices = new CopyOnWriteArrayList<>();
        final LinkedBlockingQueue<JsonNode> notices = new LinkedBlockingQueue<>();
        SaveGate saving;
        long leaseId;

        static Fixture inputEnabledRoom() throws Exception {
            var fixture = new Fixture();
            try {
                fixture.connect();
                return fixture;
            } catch (Exception | Error failure) {
                fixture.close();
                throw failure;
            }
        }

        private void connect() throws Exception {
            var room = rooms.create("Ordering");
            var host = mock(RoomSessions.Peer.class);
            doAnswer(
                            call -> {
                                hostInputs.add(call.getArgument(0));
                                return null;
                            })
                    .when(host)
                    .sendInput(any());
            var hostSession =
                    sessions.join(
                            new RoomSessions.Hello(
                                    7,
                                    room.roomId(),
                                    room.token(),
                                    "host",
                                    "Host",
                                    RoomSessions.Role.HOST),
                            host);
            if (hostSession == null)
                throw new IllegalStateException("Fixture host admission failed");
            hostSession.handle(
                    new HostCommand.Inventory(
                            List.of(new HostCommand.Runtime(7, "runtime-7", 0, 0))));
            hostSession.handle(new HostCommand.InputState(true));
            when(alice.getId()).thenReturn("alice");
            when(alice.isOpen()).thenReturn(true);
            doAnswer(
                            call -> {
                                if (call.getArgument(0) instanceof TextMessage text) {
                                    var notice = json.readTree(text.getPayload());
                                    receivedNotices.add(notice);
                                    notices.add(notice);
                                }
                                return null;
                            })
                    .when(alice)
                    .sendMessage(any());
            handler.afterConnectionEstablished(alice);
            control(
                    """
                    {"type":"hello","protocolVersion":7,"roomId":"%s","token":"%s",
                     "clientId":"alice","name":"Alice","role":"participant"}
                    """
                            .formatted(room.roomId(), room.token()));
            awaitNotice("welcome");
            control("{\"type\":\"acquire-lease\",\"terminalId\":7}");
            var result = awaitNotice("lease-result").path("result");
            if (!result.path("kind").asString().equals("granted"))
                throw new IllegalStateException("Fixture lease was not granted");
            leaseId = result.path("leaseId").asLong();
        }

        SaveGate holdNextSave() {
            saving = new SaveGate();
            doAnswer(
                            call -> {
                                saving.block();
                                return null;
                            })
                    .when(store)
                    .save(any());
            return saving;
        }

        void renameTerminal(String title) throws Exception {
            control(
                    json.writeValueAsString(
                            java.util.Map.of(
                                    "type", "rename-terminal", "terminalId", 7, "title", title)));
        }

        void releaseLease() throws Exception {
            control(
                    "{\"type\":\"release-lease\",\"terminalId\":7,\"leaseId\":%d}"
                            .formatted(leaseId));
        }

        InputFrame input(long sequence) {
            return new InputFrame(7, sequence, leaseId, new byte[] {65});
        }

        void sendInput(long sequence) throws Exception {
            handler.handleBinaryMessage(
                    alice, new BinaryMessage(InputWire.encode(input(sequence))));
        }

        private void control(String message) throws Exception {
            handler.handleTextMessage(alice, new TextMessage(message));
        }

        void awaitLeaseReleased() throws Exception {
            awaitNotice(
                    node ->
                            node.path("type").asString().equals("room-event")
                                    && node.path("event")
                                            .path("kind")
                                            .asString()
                                            .equals("lease-released"));
        }

        JsonNode awaitNotice(String type) throws Exception {
            return awaitNotice(node -> node.path("type").asString().equals(type));
        }

        private JsonNode awaitNotice(Predicate<JsonNode> matches) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (true) {
                var notice =
                        notices.poll(
                                Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                if (notice == null)
                    throw new IllegalStateException("Expected socket notice did not arrive");
                if (matches.test(notice)) return notice;
            }
        }

        public void close() {
            if (saving != null) saving.release();
            try {
                handler.close();
            } finally {
                sessions.close();
            }
        }
    }

    private static final class SaveGate {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch released = new CountDownLatch(1);

        void block() throws InterruptedException {
            entered.countDown();
            if (!released.await(5, TimeUnit.SECONDS))
                throw new IllegalStateException("Save was not released");
        }

        void awaitEntered() throws InterruptedException {
            if (!entered.await(3, TimeUnit.SECONDS))
                throw new IllegalStateException("Save did not start");
        }

        void release() {
            released.countDown();
        }
    }
}

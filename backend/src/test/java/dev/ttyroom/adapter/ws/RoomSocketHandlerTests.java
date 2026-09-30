package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.InputFrame;
import dev.ttyroom.application.ParticipantCommand;
import dev.ttyroom.application.RoomNotice.Rejected;
import dev.ttyroom.application.RoomSessions;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

class RoomSocketHandlerTests {
    @Test
    void fragmentedInputRunsOnceOnlyAfterTheCompleteHeaderAndPayloadArrive() throws Exception {
        var admission = mock(RoomSessions.class);
        var session = mock(RoomSessions.Session.class);
        when(admission.join(any(), any())).thenReturn(session);
        var socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn("fragmented-input");
        try (var handler = new RoomSocketHandler(admission, JsonMapper.builder().build())) {
            handler.afterConnectionEstablished(socket);
            handler.handleTextMessage(
                    socket,
                    new TextMessage(
                            """
                            {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                             "clientId":"alice","name":"Alice","role":"participant"}
                            """));
            var bytes = InputWire.encode(new InputFrame(7, 1, 1, new byte[] {65, 66}));

            handler.handleBinaryMessage(
                    socket, new BinaryMessage(java.util.Arrays.copyOfRange(bytes, 0, 5), false));
            int inputsBeforeCompletion = mockingDetails(session).getInvocations().size();
            handler.handleBinaryMessage(
                    socket,
                    new BinaryMessage(java.util.Arrays.copyOfRange(bytes, 5, bytes.length), true));

            assertThat(inputsBeforeCompletion).isZero();
            verify(session)
                    .input(
                            argThat(
                                    frame ->
                                            frame.terminalId() == 7
                                                    && java.util.Arrays.equals(
                                                            frame.payload(), new byte[] {65, 66})));
        }
    }

    @Test
    void fragmentedHelloIsAdmittedOnlyAfterItsFinalPart() throws Exception {
        var admission = mock(RoomSessions.class);
        when(admission.join(any(), any())).thenReturn(mock(RoomSessions.Session.class));
        var socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn("fragmented-peer");
        try (var handler = new RoomSocketHandler(admission, JsonMapper.builder().build())) {
            handler.afterConnectionEstablished(socket);
            var hello =
                    """
                    {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                     "clientId":"alice","name":"Alice","role":"participant"}
                    """;

            handler.handleTextMessage(socket, new TextMessage(hello.substring(0, 40), false));
            int admissionsBeforeFinalPart = mockingDetails(admission).getInvocations().size();
            handler.handleTextMessage(socket, new TextMessage(hello.substring(40), true));

            assertThat(admissionsBeforeFinalPart).isZero();
            verify(admission).join(any(), any());
            assertThat(handler.supportsPartialMessages()).isTrue();
        }
    }

    @Test
    void aBlockedControlCommandDoesNotHoldTheReceiveCallbackOrFollowingBinaryInput()
            throws Exception {
        var admission = mock(RoomSessions.class);
        var session = mock(RoomSessions.Session.class);
        when(admission.join(any(), any())).thenReturn(session);
        var socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn("peer");
        when(socket.isOpen()).thenReturn(true);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var completed = new CountDownLatch(1);
        var controls = new CopyOnWriteArrayList<String>();
        doAnswer(
                        call -> {
                            ParticipantCommand.RenameTerminal rename = call.getArgument(0);
                            if (rename.title().equals("First")) {
                                entered.countDown();
                                if (!release.await(5, TimeUnit.SECONDS))
                                    throw new AssertionError("Control not released");
                            }
                            controls.add(rename.title());
                            if (rename.title().equals("Second")) completed.countDown();
                            return null;
                        })
                .when(session)
                .handle(any(ParticipantCommand.class));
        try (var handler = new RoomSocketHandler(admission, JsonMapper.builder().build());
                var incoming = Executors.newSingleThreadExecutor()) {
            handler.afterConnectionEstablished(socket);
            handler.handleTextMessage(
                    socket,
                    new TextMessage(
                            """
                            {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                             "clientId":"alice","name":"Alice","role":"participant"}
                            """));
            var input = new InputFrame(7, 1, 1, new byte[] {65});
            Throwable receiverFailure;
            List<String> whileBlocked;
            try {
                var received =
                        incoming.submit(
                                () -> {
                                    handler.handleTextMessage(
                                            socket,
                                            new TextMessage(
                                                    "{\"type\":\"rename-terminal\",\"terminalId\":7,\"title\":\"First\"}"));
                                    handler.handleTextMessage(
                                            socket,
                                            new TextMessage(
                                                    "{\"type\":\"rename-terminal\",\"terminalId\":7,\"title\":\"Second\"}"));
                                    handler.handleBinaryMessage(
                                            socket, new BinaryMessage(InputWire.encode(input)));
                                });
                if (!entered.await(2, TimeUnit.SECONDS))
                    throw new AssertionError("Control did not start");
                receiverFailure = catchThrowable(() -> received.get(1, TimeUnit.SECONDS));
                whileBlocked = List.copyOf(controls);
            } finally {
                release.countDown();
            }
            if (!completed.await(2, TimeUnit.SECONDS))
                throw new AssertionError("Controls did not finish");

            assertThat(receiverFailure).isNull();
            assertThat(whileBlocked).isEmpty();
            assertThat(controls).containsExactly("First", "Second");
            verify(session).input(any(InputFrame.class));
        }
    }

    @Test
    void aPreHelloControlCannotBecomeAuthenticatedWhileWaitingForAWorker() throws Exception {
        var admission = mock(RoomSessions.class);
        var session = mock(RoomSessions.Session.class);
        when(admission.join(any(), any())).thenReturn(session);
        var socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn("peer");
        when(socket.isOpen()).thenReturn(true);
        var workerRelease = new CountDownLatch(1);
        var workers = Executors.newSingleThreadExecutor();
        workers.submit(
                () -> {
                    try {
                        workerRelease.await(3, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                });
        try (var handler =
                new RoomSocketHandler(admission, JsonMapper.builder().build(), workers)) {
            handler.afterConnectionEstablished(socket);
            handler.handleTextMessage(
                    socket,
                    new TextMessage(
                            "{\"type\":\"rename-terminal\",\"terminalId\":7,\"title\":\"Too"
                                    + " early\"}"));
            handler.handleTextMessage(
                    socket,
                    new TextMessage(
                            """
                            {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                             "clientId":"alice","name":"Alice","role":"participant"}
                            """));
            workerRelease.countDown();
            workers.shutdown();
            if (!workers.awaitTermination(2, TimeUnit.SECONDS))
                throw new AssertionError("Worker did not drain");

            verify(session, never()).handle(any(ParticipantCommand.class));
        } finally {
            workerRelease.countDown();
        }
    }

    @Test
    void closingDuringAdmissionRunsTheLateDisconnectCallbackExactlyOnce() {
        var admission = mock(RoomSessions.class);
        var socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn("peer");
        var handler = new RoomSocketHandler(admission, JsonMapper.builder().build());
        var disconnected = new AtomicInteger();
        when(admission.join(any(), any()))
                .thenAnswer(
                        call -> {
                            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
                            var session = mock(RoomSessions.Session.class);
                            doAnswer(
                                            ignored -> {
                                                disconnected.incrementAndGet();
                                                return null;
                                            })
                                    .when(session)
                                    .disconnect();
                            return session;
                        });
        try (handler) {
            handler.afterConnectionEstablished(socket);
            var hello =
                    new TextMessage(
                            """
                            {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                             "clientId":"alice","name":"Alice","role":"participant"}
                            """);

            handler.handleTextMessage(socket, hello);
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);

            assertThat(disconnected.get()).isEqualTo(1);
        }
    }

    @Test
    void anAsyncWriteFailureBeforeAdmissionReturnsStillDisconnectsExactlyOnce() throws Exception {
        var admission = mock(RoomSessions.class);
        var socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn("peer");
        when(socket.isOpen()).thenReturn(true);
        var closed = new CountDownLatch(1);
        doThrow(new IOException("disconnected")).when(socket).sendMessage(any());
        doAnswer(
                        call -> {
                            closed.countDown();
                            return null;
                        })
                .when(socket)
                .close(any());
        var disconnected = new AtomicInteger();
        when(admission.join(any(), any()))
                .thenAnswer(
                        call -> {
                            RoomSessions.Peer peer = call.getArgument(1);
                            peer.send(new Rejected("invalid-token", "token mismatch"));
                            if (!closed.await(3, TimeUnit.SECONDS))
                                throw new AssertionError("socket did not close");
                            var session = mock(RoomSessions.Session.class);
                            doAnswer(
                                            ignored -> {
                                                disconnected.incrementAndGet();
                                                return null;
                                            })
                                    .when(session)
                                    .disconnect();
                            return session;
                        });
        try (var handler = new RoomSocketHandler(admission, JsonMapper.builder().build())) {
            handler.afterConnectionEstablished(socket);
            var hello =
                    new TextMessage(
                            """
                            {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                             "clientId":"alice","name":"Alice","role":"participant"}
                            """);

            handler.handleTextMessage(socket, hello);
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);

            assertThat(disconnected.get()).isEqualTo(1);
        }
    }
}

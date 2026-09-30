package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import dev.ttyroom.application.HostCommand;
import dev.ttyroom.application.OutputFrame;
import dev.ttyroom.application.RoomSessions;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.List;

class TerminalAnnouncementOrderingTests {
    @Test
    void outputWaitsForItsTerminalAnnouncementWhileOtherTerminalsRemainLive() throws Exception {
        try (var connection = new HostConnection()) {
            connection.announceTerminal();

            connection.output(7, 1);
            connection.output(9, 1);
            var beforeAnnouncement = List.copyOf(connection.delivered);
            connection.completeControls();

            assertThat(beforeAnnouncement).containsExactly("output:9:1");
            assertThat(connection.delivered).containsExactly("output:9:1", "opened", "output:7:1");
        }
    }

    @Test
    void newOutputCannotOvertakeOutputAlreadyWaitingForTheAnnouncement() throws Exception {
        try (var connection = new HostConnection()) {
            connection.announceTerminal();
            connection.output(7, 1);
            connection.output(7, 2);
            connection.duringFirstOutput = () -> connection.output(7, 3);

            connection.completeControls();
            connection.output(7, 4);

            assertThat(connection.delivered)
                    .containsExactly(
                            "opened", "output:7:1", "output:7:2", "output:7:3", "output:7:4");
        }
    }

    @Test
    void closingDiscardsOutputStillWaitingForAnAnnouncement() throws Exception {
        try (var connection = new HostConnection()) {
            connection.announceTerminal();
            connection.output(7, 1);

            connection.handler.afterConnectionClosed(
                    connection.socket, org.springframework.web.socket.CloseStatus.NORMAL);
            connection.completeControls();

            assertThat(connection.delivered).isEmpty();
            verify(connection.session).disconnect();
        }
    }

    @Test
    void openingOutputUsesTheBoundedInboxInsteadOfGrowingWithoutLimit() throws Exception {
        try (var connection = new HostConnection()) {
            connection.announceTerminal();

            for (int seq = 1; seq <= ControlInbox.MAX_PENDING; seq++) connection.output(7, seq);
            connection.completeControls();

            assertThat(connection.delivered).isEmpty();
            verify(connection.session).disconnect();
        }
    }

    private static final class HostConnection implements AutoCloseable {
        final List<String> delivered = new ArrayList<>();
        final List<Runnable> workers = new ArrayList<>();
        final WebSocketSession socket = mock(WebSocketSession.class);
        final RoomSocketHandler handler;
        final RoomSessions.Session session = mock(RoomSessions.Session.class);
        Runnable duringFirstOutput = () -> {};

        HostConnection() throws java.io.IOException {
            var admission = mock(RoomSessions.class);
            when(admission.join(any(), any())).thenReturn(session);
            when(socket.getId()).thenReturn("host");
            when(socket.isOpen()).thenReturn(true);
            handler =
                    new RoomSocketHandler(
                            admission, JsonMapper.builder().build(), new QueuedExecutor(workers));
            doAnswer(
                            call -> {
                                delivered.add("opened");
                                return null;
                            })
                    .when(session)
                    .handle(any(HostCommand.class));
            doAnswer(
                            call -> {
                                OutputFrame frame = call.getArgument(0);
                                delivered.add("output:" + frame.terminalId() + ":" + frame.seq());
                                if (frame.terminalId() == 7 && frame.seq() == 1)
                                    duringFirstOutput.run();
                                return null;
                            })
                    .when(session)
                    .output(any());
            handler.afterConnectionEstablished(socket);
            handler.handleTextMessage(
                    socket,
                    new TextMessage(
                            """
                            {"type":"hello","protocolVersion":7,"roomId":"room","token":"token",
                             "clientId":"host","name":"Computer","role":"host"}
                            """));
        }

        void announceTerminal() {
            handler.handleTextMessage(
                    socket,
                    new TextMessage(
                            """
                            {"type":"terminal-opened","terminalId":7,"runtimeId":"runtime"}
                            """));
        }

        void output(long terminalId, long seq) {
            handler.handleBinaryMessage(
                    socket,
                    new BinaryMessage(
                            OutputWire.encode(new OutputFrame(terminalId, seq, new byte[] {65}))));
        }

        void completeControls() {
            while (!workers.isEmpty()) workers.removeFirst().run();
        }

        public void close() {
            handler.close();
        }
    }

    private static final class QueuedExecutor extends java.util.concurrent.AbstractExecutorService {
        private final List<Runnable> workers;
        private boolean stopped;

        QueuedExecutor(List<Runnable> workers) {
            this.workers = workers;
        }

        public void execute(Runnable action) {
            workers.add(action);
        }

        public void shutdown() {
            stopped = true;
        }

        public List<Runnable> shutdownNow() {
            stopped = true;
            var pending = List.copyOf(workers);
            workers.clear();
            return pending;
        }

        public boolean isShutdown() {
            return stopped;
        }

        public boolean isTerminated() {
            return stopped && workers.isEmpty();
        }

        public boolean awaitTermination(long time, java.util.concurrent.TimeUnit unit) {
            return isTerminated();
        }
    }
}

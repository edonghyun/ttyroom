package dev.ttyroom.adapter.ws;

import dev.ttyroom.application.HostCommand;
import dev.ttyroom.application.InputFrame;
import dev.ttyroom.application.OutputFrame;
import dev.ttyroom.application.ParticipantCommand;
import dev.ttyroom.application.RoomNotice;
import dev.ttyroom.application.RoomSessions;

import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledThreadPoolExecutor;

public final class RoomSocketHandler extends TextWebSocketHandler implements AutoCloseable {
    public record Limits(long sendBufferDropThresholdBytes, long maxReceivedBinaryBytes) {
        public static final Limits DEFAULT = new Limits(1_048_576, 1_048_576);

        public Limits {
            if (sendBufferDropThresholdBytes < 0 || maxReceivedBinaryBytes <= 0)
                throw new IllegalArgumentException("Invalid WebSocket limits");
        }
    }

    private final Limits limits;
    // ws 8.x defaults to a 100 MiB assembled-message limit. Check UTF-8 bytes as Node does.
    static final int MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
    private static final int RECEIVE_CHUNK_SIZE = 16 * 1024;
    private final RoomSessions sessions;
    private final JsonMapper json;
    private final ConcurrentHashMap<String, Connection> connections = new ConcurrentHashMap<>();

    private final ExecutorService controlWorkers;
    private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1);
    private volatile boolean stopped;

    public RoomSocketHandler(RoomSessions sessions, JsonMapper json) {
        this(sessions, json, Executors.newVirtualThreadPerTaskExecutor());
    }

    public RoomSocketHandler(RoomSessions sessions, JsonMapper json, Limits limits) {
        this(sessions, json, Executors.newVirtualThreadPerTaskExecutor(), limits);
    }

    RoomSocketHandler(RoomSessions sessions, JsonMapper json, ExecutorService controlWorkers) {
        this(sessions, json, controlWorkers, Limits.DEFAULT);
    }

    private RoomSocketHandler(
            RoomSessions sessions, JsonMapper json, ExecutorService controlWorkers, Limits limits) {
        this.limits = java.util.Objects.requireNonNull(limits);
        this.controlWorkers = controlWorkers;
        this.sessions = sessions;
        this.json = json;
        deadlines.setRemoveOnCancelPolicy(true);
    }

    private final class Connection implements RoomSessions.Peer {
        final WebSocketSession socket;
        final SocketSender sender;
        final ControlInbox controls;
        final IncomingMessages incoming =
                new IncomingMessages(
                        MAX_MESSAGE_BYTES,
                        (int) Math.min(MAX_MESSAGE_BYTES, limits.maxReceivedBinaryBytes()));
        private RoomSessions.Session session;
        // Counts the announcement plus output waiting for it. A late frame cannot overtake
        // earlier deferred output when the announcement itself finishes.
        private final Map<Long, Integer> openingDeliveries = new HashMap<>();
        private boolean admissionStarted;
        private boolean closed;

        Connection(WebSocketSession socket) {
            this.socket = socket;
            this.controls =
                    new ControlInbox(
                            controlWorkers,
                            MAX_MESSAGE_BYTES,
                            failure -> {
                                System.getLogger(RoomSocketHandler.class.getName())
                                        .log(
                                                System.Logger.Level.ERROR,
                                                "WebSocket control failed",
                                                failure);
                                close(CloseStatus.SERVER_ERROR);
                            });
            this.sender =
                    new SocketSender(
                            socket,
                            deadlines,
                            () -> {
                                connections.remove(socket.getId(), this);
                                disconnected();
                            });
        }

        synchronized boolean beginAdmission() {
            if (admissionStarted || closed) return false;
            admissionStarted = true;
            return true;
        }

        void completeAdmission(RoomSessions.Session admitted) {
            if (admitted == null) return;
            boolean alreadyClosed;
            synchronized (this) {
                alreadyClosed = closed;
                if (!closed) session = admitted;
            }
            if (alreadyClosed) admitted.disconnect();
        }

        void disconnected() {
            RoomSessions.Session callback;
            synchronized (this) {
                if (closed) return;
                closed = true;
                incoming.close();
                controls.close();
                openingDeliveries.clear();
                callback = session;
                session = null;
            }
            // Never hold the connection monitor while acquiring room state.
            if (callback != null) callback.disconnect();
        }

        void enqueue(Runnable control, int bytes) {
            boolean admitted;
            synchronized (this) {
                if (closed) return;
                admitted = session != null;
            }
            // Admission is a fact at receipt, not something a queued command can acquire later.
            if (!admitted) {
                bad(this, "hello must precede control messages");
                return;
            }
            // Graceful shutdown finishes accepted work; a late offer must not discard that FIFO.
            if (!controls.offer(control, bytes) && !stopped) close(CloseStatus.POLICY_VIOLATION);
        }

        void handle(HostCommand command) {
            RoomSessions.Session admitted;
            synchronized (this) {
                if (closed) return;
                admitted = session;
            }
            if (admitted == null) bad(this, "hello must precede host reports");
            else admitted.handle(command);
        }

        void enqueue(HostCommand command, int bytes) {
            Long opening = null;
            synchronized (this) {
                if (session != null && command instanceof HostCommand.TerminalOpened opened) {
                    opening = opened.terminalId();
                    openingDeliveries.merge(opening, 1, Integer::sum);
                }
            }
            var terminalId = opening;
            enqueue(
                    () -> {
                        try {
                            handle(command);
                        } finally {
                            if (terminalId != null) completeOpeningDelivery(terminalId);
                        }
                    },
                    bytes);
        }

        private synchronized void completeOpeningDelivery(long terminalId) {
            openingDeliveries.computeIfPresent(
                    terminalId, (ignored, count) -> count == 1 ? null : count - 1);
        }

        void output(OutputFrame frame) {
            boolean deferred;
            synchronized (this) {
                if (closed) return;
                deferred = openingDeliveries.containsKey(frame.terminalId());
                if (deferred) openingDeliveries.merge(frame.terminalId(), 1, Integer::sum);
            }
            if (!deferred) {
                deliverOutput(frame);
                return;
            }
            // Reuse the bounded control inbox only during this terminal's announcement.
            // Other terminals, input, and established output keep their direct path.
            enqueue(
                    () -> {
                        try {
                            deliverOutput(frame);
                        } finally {
                            completeOpeningDelivery(frame.terminalId());
                        }
                    },
                    frame.size() + 9);
        }

        private void deliverOutput(OutputFrame frame) {
            RoomSessions.Session admitted;
            synchronized (this) {
                if (closed) return;
                admitted = session;
            }
            if (admitted == null) bad(this, "hello must precede output");
            else admitted.output(frame);
        }

        void input(InputFrame frame) {
            RoomSessions.Session admitted;
            synchronized (this) {
                if (closed) return;
                admitted = session;
            }
            if (admitted == null) bad(this, "hello must precede input");
            else admitted.input(frame);
        }

        @Override
        public void sendInput(InputFrame frame) {
            if (!socket.isOpen()) throw new RoomSessions.PeerUnavailable("WebSocket is closed");
            sender.send(new BinaryMessage(InputWire.encode(frame)));
        }

        void handle(ParticipantCommand command) {
            RoomSessions.Session admitted;
            synchronized (this) {
                if (closed) return;
                admitted = session;
            }
            if (admitted == null) bad(this, "hello must precede participant requests");
            else admitted.handle(command);
        }

        @Override
        public boolean offerOutput(OutputFrame frame, RoomNotice.OutputGap precedingGap) {
            if (!socket.isOpen()) throw new RoomSessions.PeerUnavailable("WebSocket is closed");
            var batch = new ArrayList<WebSocketMessage<?>>();
            if (precedingGap != null) {
                batch.add(
                        new TextMessage(
                                json.writeValueAsString(
                                        RoomProtocol.encode(
                                                new RoomNotice.Sync(
                                                        frame.terminalId(),
                                                        precedingGap.toSeq())))));
                batch.add(
                        new TextMessage(
                                json.writeValueAsString(RoomProtocol.encode(precedingGap))));
            }
            batch.add(new BinaryMessage(OutputWire.encode(frame)));
            return sender.offerOutput(batch, limits.sendBufferDropThresholdBytes());
        }

        @Override
        public void replayOutput(List<OutputFrame> frames, RoomNotice.Sync boundary) {
            if (!socket.isOpen()) throw new RoomSessions.PeerUnavailable("WebSocket is closed");
            sender.replay(
                    frames,
                    new TextMessage(json.writeValueAsString(RoomProtocol.encode(boundary))));
        }

        @Override
        public void send(RoomNotice notice) {
            if (!socket.isOpen()) throw new RoomSessions.PeerUnavailable("WebSocket is closed");
            // Serialization failures are programming errors, not disconnected peers.
            var text = new TextMessage(json.writeValueAsString(RoomProtocol.encode(notice)));
            sender.send(text);
        }

        @Override
        public void close() {
            close(CloseStatus.NORMAL);
        }

        void close(CloseStatus status) {
            try {
                disconnected();
            } finally {
                sender.finish(status);
            }
        }
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession socket) {
        // Tomcat allocates these buffers per connection. They are chunk sizes, not the logical
        // message ceiling: IncomingMessages assembles partial callbacks under the existing limits.
        socket.setTextMessageSizeLimit(RECEIVE_CHUNK_SIZE);
        socket.setBinaryMessageSizeLimit(RECEIVE_CHUNK_SIZE);
        var connection = new Connection(socket);
        connections.put(socket.getId(), connection);
        if (stopped) connection.sender.abort(CloseStatus.GOING_AWAY);
    }

    @Override
    public boolean supportsPartialMessages() {
        return true;
    }

    @Override
    protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
        var connection = connections.get(socket.getId());
        if (stopped || connection == null) return;
        try {
            message = connection.incoming.receive(message);
        } catch (IncomingMessages.TooLarge tooLarge) {
            connection.close(CloseStatus.TOO_BIG_TO_PROCESS);
            return;
        }
        if (message == null) return;
        int messageBytes = message.getPayload().getBytes(StandardCharsets.UTF_8).length;
        if (messageBytes > MAX_MESSAGE_BYTES) {
            connection.close(CloseStatus.TOO_BIG_TO_PROCESS);
            return;
        }
        JsonNode node;
        try {
            node =
                    json.reader()
                            .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                            .readTree(message.getPayload());
        } catch (JacksonException invalid) {
            bad(connection, "invalid JSON");
            return;
        }
        if (node != null
                && node.isObject()
                && node.has("type")
                && node.get("type").isString()
                && node.get("type").asString().equals("hello")) {
            var hello = RoomProtocol.hello(node);
            if (hello == null) {
                bad(connection, "expected a valid hello");
                return;
            }
            if (!connection.beginAdmission()) {
                bad(connection, "이미 입장한 연결의 hello");
                return;
            }
            connection.completeAdmission(sessions.join(hello, connection));
            return;
        }
        var participantCommand = RoomProtocol.participantCommand(node);
        if (participantCommand != null) {
            if (participantCommand instanceof ParticipantCommand.MoveCursor)
                connection.handle(participantCommand);
            else connection.enqueue(() -> connection.handle(participantCommand), messageBytes);
            return;
        }
        var command = RoomProtocol.hostCommand(node);
        if (command == null) bad(connection, "expected a supported control message");
        else connection.enqueue(command, messageBytes);
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession socket, BinaryMessage message) {
        var connection = connections.get(socket.getId());
        if (stopped || connection == null) return;
        try {
            message = connection.incoming.receive(message);
        } catch (IncomingMessages.TooLarge tooLarge) {
            connection.close(
                    limits.maxReceivedBinaryBytes() < MAX_MESSAGE_BYTES
                            ? CloseStatus.POLICY_VIOLATION
                            : CloseStatus.TOO_BIG_TO_PROCESS);
            return;
        }
        if (message == null) return;
        // Bound each frame including its header. Established streams remain direct; output
        // following terminal-opened waits for that announcement through the bounded inbox.
        if (message.getPayloadLength() > limits.maxReceivedBinaryBytes()) {
            connection.close(CloseStatus.POLICY_VIOLATION);
            return;
        }
        var frame = OutputWire.decode(message.getPayload());
        if (frame != null) {
            connection.output(frame);
            return;
        }
        var input = InputWire.decode(message.getPayload());
        if (input == null) bad(connection, "expected a valid terminal frame");
        else connection.input(input);
    }

    private void bad(Connection connection, String reason) {
        try {
            connection.send(new RoomNotice.Rejected("bad-message", reason));
        } catch (RoomSessions.PeerUnavailable unavailable) {
            connection.close();
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
        var connection = connections.remove(socket.getId());
        if (connection != null) {
            try {
                connection.disconnected();
            } finally {
                connection.sender.abort(status);
            }
        }
    }

    @Override
    public void close() {
        stopped = true;
        var draining = List.copyOf(connections.values());
        draining.forEach(connection -> connection.controls.finish());
        controlWorkers.close();
        draining.forEach(
                connection -> {
                    connection.disconnected();
                    connection.sender.abort(CloseStatus.GOING_AWAY);
                });
        connections.clear();
        deadlines.shutdownNow();
    }
}

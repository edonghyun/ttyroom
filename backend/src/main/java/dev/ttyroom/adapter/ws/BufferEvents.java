package dev.ttyroom.adapter.ws;

import jdk.jfr.Category;
import jdk.jfr.Enabled;
import jdk.jfr.Event;
import jdk.jfr.EventType;
import jdk.jfr.Label;
import jdk.jfr.Name;
import jdk.jfr.StackTrace;

/** Opt-in JFR observations. No identities, credentials, commands or terminal contents. */
final class BufferEvents {
    private static final EventType WAIT = EventType.getEventType(ControlQueueWait.class);
    private static final EventType PRESSURE = EventType.getEventType(BufferPressure.class);

    private BufferEvents() {}

    static ControlQueueWait queued() {
        if (!WAIT.isEnabled()) return null;
        var event = new ControlQueueWait();
        event.begin();
        return event;
    }

    static void started(ControlQueueWait event) {
        if (event == null) return;
        event.end();
        event.commit();
    }

    static void pressure(String boundary, String outcome, long pendingBytes, int pendingMessages) {
        if (!PRESSURE.isEnabled()) return;
        var event = new BufferPressure();
        event.boundary = boundary;
        event.outcome = outcome;
        event.pendingBytes = pendingBytes;
        event.pendingMessages = pendingMessages;
        event.commit();
    }

    @Name("ttyroom.ControlQueueWait")
    @Label("Accepted control enqueue to worker start")
    @Category("TTYRoom")
    @Enabled(false)
    @StackTrace(false)
    static final class ControlQueueWait extends Event {}

    @Name("ttyroom.BufferPressure")
    @Label("Bounded buffer drop or rejection")
    @Category("TTYRoom")
    @Enabled(false)
    @StackTrace(false)
    static final class BufferPressure extends Event {
        String boundary;
        String outcome;
        long pendingBytes;
        int pendingMessages;
    }
}

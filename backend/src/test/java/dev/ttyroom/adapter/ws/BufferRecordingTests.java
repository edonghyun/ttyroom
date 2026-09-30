package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;

import jdk.jfr.Recording;
import jdk.jfr.consumer.RecordingFile;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;

class BufferRecordingTests {
    @TempDir Path directory;

    @Test
    void recordingObservesQueueWaitAndRejectionWithoutChangingAdmission() throws Exception {
        var workers = new ArrayList<Runnable>();
        var actions = new ArrayList<String>();
        var inbox =
                new ControlInbox(
                        workers::add,
                        10,
                        failure -> {
                            throw new AssertionError(failure);
                        });
        var file = directory.resolve("buffers.jfr");
        try (var recording = new Recording()) {
            recording.enable("ttyroom.ControlQueueWait");
            recording.enable("ttyroom.BufferPressure");
            recording.start();

            var accepted = inbox.offer(() -> actions.add("accepted"), 8);
            var rejected = inbox.offer(() -> actions.add("rejected"), 3);
            workers.getFirst().run();
            recording.stop();
            recording.dump(file);
            var events = RecordingFile.readAllEvents(file);
            var waits =
                    events.stream()
                            .filter(
                                    e ->
                                            e.getEventType()
                                                    .getName()
                                                    .equals("ttyroom.ControlQueueWait"))
                            .toList();
            var pressure =
                    events.stream()
                            .filter(
                                    e ->
                                            e.getEventType()
                                                    .getName()
                                                    .equals("ttyroom.BufferPressure"))
                            .toList();

            assertThat(accepted).isTrue();
            assertThat(rejected).isFalse();
            assertThat(actions).containsExactly("accepted");
            assertThat(waits).hasSize(1);
            assertThat(waits.getFirst().getDuration().toNanos()).isGreaterThanOrEqualTo(0);
            assertThat(pressure).hasSize(1);
            assertThat(pressure.getFirst().getString("boundary")).isEqualTo("control-inbox");
            assertThat(pressure.getFirst().getString("outcome")).isEqualTo("rejected");
            assertThat(pressure.getFirst().getLong("pendingBytes")).isEqualTo(8);
        }
    }
}

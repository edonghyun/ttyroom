package dev.ttyroom.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class HostPresenceTests {
    @Test
    void aNewConnectionStartsOfflineWithInputBlocked() {
        var host = new HostPresence("host", "Host");

        assertThat(host.snapshot()).isEqualTo(new HostPresence.State("host", "Host", false, false));
    }

    @Test
    void inventoryCompletionResetsAnEarlierInputReport() {
        var host = new HostPresence("host", "Host");
        host.reportInputState(true);

        host.inventoryAccepted();

        assertThat(host.snapshot()).isEqualTo(new HostPresence.State("host", "Host", true, false));
    }

    @Test
    void reportingTheSameInputStateIsNotAChange() {
        var host = new HostPresence("host", "Host");
        host.inventoryAccepted();
        host.reportInputState(true);

        var changed = host.reportInputState(true);

        assertThat(changed).isFalse();
        assertThat(host.snapshot().remoteInputAllowed()).isTrue();
    }

    @Test
    void disconnectChangesAvailabilityWithoutRewritingTheReportedInputState() {
        var host = new HostPresence("host", "Host");
        host.inventoryAccepted();
        host.reportInputState(true);

        host.disconnected();

        assertThat(host.snapshot()).isEqualTo(new HostPresence.State("host", "Host", false, true));
    }
}

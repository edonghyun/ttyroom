package dev.ttyroom.domain;

/** Host availability and reported input permission are independent facts. */
public final class HostPresence {
    public record State(String hostId, String name, boolean online, boolean remoteInputAllowed) {}

    private final String hostId;
    private final String name;
    private boolean online;
    private boolean remoteInputAllowed;

    /** A new/replacement connection starts in recovery with remote input blocked. */
    public HostPresence(String hostId, String name) {
        this.hostId = hostId;
        this.name = name;
    }

    public void inventoryAccepted() {
        online = true;
        remoteInputAllowed = false;
    }

    public boolean reportInputState(boolean allowed) {
        if (remoteInputAllowed == allowed) return false;
        remoteInputAllowed = allowed;
        return true;
    }

    public void disconnected() {
        online = false;
    }

    public State snapshot() {
        return new State(hostId, name, online, remoteInputAllowed);
    }
}

package dev.ttyroom.application;

import java.util.List;

/** Blocking storage boundary. Calls must run outside the room's state monitor. */
public interface RoomStore extends AutoCloseable {
    List<RoomDirectory.StoredRoom> loadAll();

    /** Atomically replaces one durable room, or throws without claiming success. */
    void save(RoomDirectory.StoredRoom room);

    void delete(String roomId);

    @Override
    void close();

    /** Default process-only mode, deliberately offering no restart persistence. */
    static RoomStore transientOnly() {
        return new RoomStore() {
            public List<RoomDirectory.StoredRoom> loadAll() {
                return List.of();
            }

            public void save(RoomDirectory.StoredRoom room) {}

            public void delete(String roomId) {}

            public void close() {}
        };
    }
}

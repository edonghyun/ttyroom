package dev.ttyroom.adapter.sqlite;

import dev.ttyroom.application.RoomDirectory.StoredRoom;
import dev.ttyroom.application.RoomStore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

/** One connection owns SQL calls and close; room command ordering remains in RoomDirectory. */
public final class SqliteRoomStore implements RoomStore {
    private final Connection connection;
    private final StoredRoomJson records = new StoredRoomJson();

    public SqliteRoomStore(Path file) {
        Connection opened = null;
        try {
            var absolute = file.toAbsolutePath();
            Files.createDirectories(absolute.getParent());
            opened = DriverManager.getConnection("jdbc:sqlite:" + absolute);
            try (var statement = opened.createStatement()) {
                statement.execute("PRAGMA busy_timeout = 5000");
                statement.execute("PRAGMA foreign_keys = ON");
                statement.execute(
                        """
                        CREATE TABLE IF NOT EXISTS rooms (
                            room_id TEXT PRIMARY KEY,
                            record_json TEXT NOT NULL
                        ) STRICT
                        """);
            }
            connection = opened;
        } catch (SQLException | IOException failure) {
            if (opened != null) {
                try {
                    opened.close();
                } catch (SQLException cleanup) {
                    failure.addSuppressed(cleanup);
                }
            }
            throw new IllegalStateException("Cannot open SQLite room store", failure);
        }
    }

    @Override
    public synchronized List<StoredRoom> loadAll() {
        try (var statement =
                        connection.prepareStatement(
                                "SELECT record_json FROM rooms ORDER BY room_id");
                var rows = statement.executeQuery()) {
            var loaded = new ArrayList<StoredRoom>();
            while (rows.next()) loaded.add(records.decode(rows.getString(1)));
            return List.copyOf(loaded);
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot load SQLite rooms", failure);
        }
    }

    @Override
    public synchronized void save(StoredRoom room) {
        var encoded = records.encode(room);
        try (var statement =
                connection.prepareStatement(
                        """
                        INSERT INTO rooms (room_id, record_json) VALUES (?, ?)
                        ON CONFLICT(room_id) DO UPDATE SET record_json = excluded.record_json
                        """)) {
            statement.setString(1, room.roomId());
            statement.setString(2, encoded);
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot save SQLite room", failure);
        }
    }

    @Override
    public synchronized void delete(String roomId) {
        try (var statement = connection.prepareStatement("DELETE FROM rooms WHERE room_id = ?")) {
            statement.setString(1, roomId);
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot delete SQLite room", failure);
        }
    }

    @Override
    public synchronized void close() {
        try {
            connection.close();
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot close SQLite room store", failure);
        }
    }
}

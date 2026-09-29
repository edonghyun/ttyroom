package dev.ttyroom.adapter.sqlite;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import dev.ttyroom.application.RoomDirectory;
import dev.ttyroom.application.RoomDirectory.StoredRoom;
import dev.ttyroom.domain.RoomControl;
import dev.ttyroom.domain.TerminalWorkspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.SQLException;

class SqliteRoomStoreTests {
    @TempDir Path directory;

    @Test
    void reopeningTheFileRestoresTheCompleteDurableRoom() {
        var file = directory.resolve("rooms.sqlite");
        var expected = roomWithEveryTerminalLifecycle();
        try (var store = new SqliteRoomStore(file)) {
            store.save(expected);
        }

        try (var reopened = new SqliteRoomStore(file)) {
            var restored = reopened.loadAll();

            assertThat(restored).containsExactly(expected);
        }
    }

    @Test
    void deletedRoomDoesNotReturnWhenTheFileIsReopened() {
        var file = directory.resolve("rooms.sqlite");
        var room = roomWithEveryTerminalLifecycle();
        var other = new StoredRoom("other", "Other", room.tokenHash(), room.control());
        try (var store = new SqliteRoomStore(file)) {
            store.save(room);
            store.save(other);

            store.delete(room.roomId());
            store.delete(room.roomId());
        }

        try (var reopened = new SqliteRoomStore(file)) {
            assertThat(reopened.loadAll()).containsExactly(other);
        }
    }

    @Test
    void readsTheVersionOneRecordProducedByTheNodeImplementation() throws Exception {
        var file = directory.resolve("node.sqlite");
        insertRawRecord(file, nodeRecord());

        try (var store = new SqliteRoomStore(file)) {
            var restored = store.loadAll();

            assertThat(restored).containsExactly(roomWithEveryTerminalLifecycle());
        }
    }

    @Test
    void oldNodeRecordsWithoutGeometryUseTheOriginalDefault() throws Exception {
        var file = directory.resolve("old-node.sqlite");
        var json = JsonMapper.builder().build();
        var record = json.readTree(nodeRecord());
        ((ObjectNode) record.path("terminals").get(0).path("view")).remove("geometry");
        insertRawRecord(file, json.writeValueAsString(record));

        try (var store = new SqliteRoomStore(file)) {
            var restored = store.loadAll();

            assertThat(restored).containsExactly(roomWithEveryTerminalLifecycle());
        }
    }

    @Test
    void aReplacementSurvivesReopeningWithoutDuplicatingTheRoom() {
        var file = directory.resolve("rooms.sqlite");
        var original = roomWithEveryTerminalLifecycle();
        var replacement =
                new StoredRoom(
                        original.roomId(), "Updated", original.tokenHash(), original.control());
        try (var store = new SqliteRoomStore(file)) {
            store.save(original);

            store.save(replacement);
        }

        try (var reopened = new SqliteRoomStore(file)) {
            assertThat(reopened.loadAll()).containsExactly(replacement);
        }
    }

    @Test
    void aFailedReplacementKeepsTheSavedRoomAndLaterWritesCanProceed() throws Exception {
        var file = directory.resolve("rooms.sqlite");
        var original = roomWithEveryTerminalLifecycle();
        var replacement =
                new StoredRoom(
                        original.roomId(), "Updated", original.tokenHash(), original.control());
        try (var store = new SqliteRoomStore(file)) {
            store.save(original);
            executeSql(
                    file,
                    """
                    CREATE TRIGGER reject_replacement BEFORE UPDATE ON rooms
                    BEGIN SELECT RAISE(ABORT, 'Controlled write failure'); END
                    """);

            var failure = catchThrowable(() -> store.save(replacement));
            var afterFailure = store.loadAll();
            executeSql(file, "DROP TRIGGER reject_replacement");
            store.save(replacement);
            var afterRetry = store.loadAll();

            assertThat(failure)
                    .isInstanceOf(IllegalStateException.class)
                    .hasCauseInstanceOf(SQLException.class);
            assertThat(afterFailure).containsExactly(original);
            assertThat(afterRetry).containsExactly(replacement);
        }
    }

    @Test
    void aNewDirectoryAcceptsTheOriginalInvitationAfterReopeningTheFile() {
        var file = directory.resolve("rooms.sqlite");
        RoomDirectory.Invitation invitation;
        try (var rooms = new RoomDirectory(new SqliteRoomStore(file))) {
            invitation = rooms.create("Saved invitation");
        }

        try (var restored = new RoomDirectory(new SqliteRoomStore(file))) {
            var accepted = restored.acceptsToken(invitation.roomId(), invitation.token());

            assertThat(accepted).isTrue();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"null", "{}", "{broken"})
    void corruptRecordsFailLoadingInsteadOfDisappearing(String record) throws Exception {
        var file = directory.resolve("corrupt.sqlite");
        insertRawRecord(file, record);
        try (var store = new SqliteRoomStore(file)) {
            var failure = catchThrowable(store::loadAll);

            assertThat(failure)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("Invalid stored room record");
        }
    }

    @Test
    void recordsFromAnUnknownSchemaVersionFailLoading() throws Exception {
        var file = directory.resolve("future.sqlite");
        var json = JsonMapper.builder().build();
        var record = (ObjectNode) json.readTree(nodeRecord());
        record.put("schemaVersion", 99);
        insertRawRecord(file, json.writeValueAsString(record));
        try (var store = new SqliteRoomStore(file)) {
            var failure = catchThrowable(store::loadAll);

            assertThat(failure)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("Invalid stored room record");
        }
    }

    @Test
    void invalidGeometryIsRejectedBeforeTheRecordEntersTheDomain() throws Exception {
        var file = directory.resolve("invalid-geometry.sqlite");
        var json = JsonMapper.builder().build();
        var record = json.readTree(nodeRecord());
        ((ObjectNode) record.path("terminals").get(0).path("view").path("geometry"))
                .put("width", -1);
        insertRawRecord(file, json.writeValueAsString(record));
        try (var store = new SqliteRoomStore(file)) {
            var failure = catchThrowable(store::loadAll);

            assertThat(failure)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("Invalid stored room record");
        }
    }

    @Test
    void invalidWritesLeaveThePreviouslySavedRecordUntouched() {
        var file = directory.resolve("rooms.sqlite");
        var original = roomWithEveryTerminalLifecycle();
        var control = RoomControl.restore(original.control());
        control.updateTerminalGeometry(1, new TerminalWorkspace.Geometry(0, 0, -1, 100));
        var invalid =
                new StoredRoom(
                        original.roomId(),
                        original.name(),
                        original.tokenHash(),
                        control.durableState());
        try (var store = new SqliteRoomStore(file)) {
            store.save(original);

            var failure = catchThrowable(() -> store.save(invalid));
            var afterFailure = store.loadAll();

            assertThat(failure).isInstanceOf(IllegalArgumentException.class);
            assertThat(afterFailure).containsExactly(original);
        }
    }

    @Test
    void closedStoreRejectsNewOperationsAndRepeatedCloseIsHarmless() {
        var store = new SqliteRoomStore(directory.resolve("closed.sqlite"));
        var room = roomWithEveryTerminalLifecycle();
        store.close();

        store.close();
        var loadFailure = catchThrowable(store::loadAll);
        var saveFailure = catchThrowable(() -> store.save(room));
        var deleteFailure = catchThrowable(() -> store.delete(room.roomId()));

        assertThat(new Throwable[] {loadFailure, saveFailure, deleteFailure})
                .allSatisfy(
                        failure -> assertThat(failure).isInstanceOf(IllegalStateException.class));
    }

    @Test
    void diskRecordsKeepTheVersionOneEnvelopeAndLowercaseEnums() throws Exception {
        var file = directory.resolve("rooms.sqlite");
        try (var store = new SqliteRoomStore(file)) {
            store.save(roomWithEveryTerminalLifecycle());
        }

        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
                var statement = connection.createStatement();
                var rows = statement.executeQuery("SELECT record_json FROM rooms")) {
            if (!rows.next()) throw new IllegalStateException("Stored row is missing");
            var record = JsonMapper.builder().build().readTree(rows.getString(1));

            assertThat(record.path("schemaVersion").asInt()).isEqualTo(1);
            assertThat(record.has("control")).isFalse();
            assertThat(record.path("nextTerminalId").asLong()).isEqualTo(4);
            assertThat(record.path("terminals").get(1).path("view").path("mode").asString())
                    .isEqualTo("shared");
            assertThat(record.path("terminals").get(2).path("view").path("status").asString())
                    .isEqualTo("exited");
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "missing",
                "null",
                "unknown-role",
                "bad-id",
                "bad-digest",
                "duplicate-subject",
                "duplicate-digest",
                "unexpected-secret",
                "overflow-version"
            })
    void invalidCredentialRecordsFailLoadingWithoutExposingStoredValues(String corruption)
            throws Exception {
        var file = directory.resolve("invalid-credentials.sqlite");
        insertRawRecord(file, corruptCredentialRecord(corruption));

        try (var store = new SqliteRoomStore(file)) {
            var failure = catchThrowable(store::loadAll);

            assertThat(failure)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("Invalid stored room record")
                    .hasNoCause();
        }
    }

    private static String corruptCredentialRecord(String corruption) throws Exception {
        var json = JsonMapper.builder().build();
        var root = (ObjectNode) json.readTree(nodeRecord());
        root.put("schemaVersion", 2);
        var credentials = root.putArray("credentials");
        var stored = credentials.addObject();
        var subject = stored.putObject("subject");
        subject.put("role", "participant");
        subject.put("id", "00000000-0000-4000-8000-000000000001");
        stored.put("digest", "a".repeat(64));
        switch (corruption) {
            case "missing" -> root.remove("credentials");
            case "null" -> root.putNull("credentials");
            case "unknown-role" -> subject.put("role", "admin");
            case "bad-id" -> subject.put("id", "not-a-subject");
            case "bad-digest" -> stored.put("digest", "not-a-digest");
            case "duplicate-subject" -> credentials.add(stored.deepCopy());
            case "duplicate-digest" -> {
                var duplicate = stored.deepCopy();
                ((ObjectNode) duplicate.path("subject"))
                        .put("id", "00000000-0000-4000-8000-000000000002");
                credentials.add(duplicate);
            }
            case "unexpected-secret" -> stored.put("secret", "sensitive-test-value");
            case "overflow-version" -> root.put("schemaVersion", 4_294_967_298L);
            default -> throw new IllegalArgumentException("Unknown corruption fixture");
        }
        return json.writeValueAsString(root);
    }

    private static void executeSql(Path file, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
                var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static String nodeRecord() throws Exception {
        try (var source =
                SqliteRoomStoreTests.class.getResourceAsStream("/sqlite/node-v1-room.json")) {
            if (source == null) throw new IllegalStateException("Node fixture is missing");
            return new String(source.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void insertRawRecord(Path file, String record) throws Exception {
        try (var initialized = new SqliteRoomStore(file)) {}
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
                var statement = connection.prepareStatement("INSERT INTO rooms VALUES (?, ?)")) {
            statement.setString(1, "room-1");
            statement.setString(2, record);
            statement.executeUpdate();
        }
    }

    private static StoredRoom roomWithEveryTerminalLifecycle() {
        var control = new RoomControl();
        control.rememberHost("host", "Laptop");
        control.openTerminal("host");
        var running = control.openTerminal("host");
        control.confirmTerminalOpened("host", running.terminalId(), "runtime-2");
        control.renameTerminal(running.terminalId(), "API logs");
        control.setTerminalMode(running.terminalId(), TerminalWorkspace.Mode.SHARED, "host");
        control.updateTerminalMetadata(
                "host",
                running.terminalId(),
                new TerminalWorkspace.Metadata("/work/로그", "main", "java"));
        control.updateTerminalGeometry(
                running.terminalId(), new TerminalWorkspace.Geometry(1, 2, 800, 600));
        var exited = control.openTerminal("host");
        control.confirmTerminalOpened("host", exited.terminalId(), "runtime-3");
        control.terminalExited("host", exited.terminalId(), 9.0);
        return new StoredRoom("room-1", "Debug room", "a".repeat(64), control.durableState());
    }
}

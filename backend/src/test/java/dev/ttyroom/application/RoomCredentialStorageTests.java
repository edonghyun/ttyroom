package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;

import dev.ttyroom.adapter.sqlite.SqliteRoomStore;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.Optional;

class RoomCredentialStorageTests {
    @TempDir Path directory;

    @ParameterizedTest
    @EnumSource(RoomCredentials.Role.class)
    void reopeningRestoresTheIssuedSubjectAndStoresNoPlaintextSecret(RoomCredentials.Role role)
            throws Exception {
        try (var fixture = new PersistentRoom(directory.resolve("credentials.sqlite"))) {
            var issued = fixture.issue(role);

            fixture.reopen();
            var authenticated = fixture.authenticate(issued.secret());
            var storedJson = fixture.storedJson();

            assertThat(authenticated).contains(issued.subject());
            assertThat(storedJson).contains(issued.subject().id()).doesNotContain(issued.secret());
            assertThat(fixture.snapshot().credentials())
                    .singleElement()
                    .satisfies(
                            stored -> {
                                assertThat(stored.digest()).matches("[a-f0-9]{64}");
                                assertThat(stored.toString()).doesNotContain(stored.digest());
                            });
        }
    }

    @Test
    void reopeningRejectsTheRevokedCredentialAndKeepsTheOtherSubject() {
        try (var fixture = new PersistentRoom(directory.resolve("revoked.sqlite"))) {
            var alice = fixture.issue(RoomCredentials.Role.PARTICIPANT);
            var bob = fixture.issue(RoomCredentials.Role.HOST);

            fixture.revoke(alice);
            fixture.reopen();
            var revoked = fixture.authenticate(alice.secret());
            var retained = fixture.authenticate(bob.secret());

            assertThat(revoked).isEmpty();
            assertThat(retained).contains(bob.subject());
        }
    }

    @Test
    void workspaceWritesKeepCredentialsAndCredentialWritesKeepTheWorkspace() {
        try (var fixture = new PersistentRoom(directory.resolve("workspace.sqlite"))) {
            var terminalId = fixture.openTerminal();

            var issued = fixture.issue(RoomCredentials.Role.HOST);
            fixture.renameTerminal(terminalId, "Saved title");
            fixture.reopen();
            var authenticated = fixture.authenticate(issued.secret());
            var terminals = fixture.snapshot().control().workspace().terminals();

            assertThat(authenticated).contains(issued.subject());
            assertThat(terminals)
                    .singleElement()
                    .satisfies(
                            terminal ->
                                    assertThat(terminal.view().title()).isEqualTo("Saved title"));
        }
    }

    @Test
    void revokingTheLastCredentialLeavesNoAuthenticationAfterReopening() {
        try (var fixture = new PersistentRoom(directory.resolve("empty.sqlite"))) {
            var issued = fixture.issue(RoomCredentials.Role.HOST);

            fixture.revoke(issued);
            fixture.reopen();
            var authenticated = fixture.authenticate(issued.secret());

            assertThat(authenticated).isEmpty();
            assertThat(fixture.snapshot().credentials()).isEmpty();
        }
    }

    /** Owns the file-backed application and replaces it with fresh state on reopen. */
    private static final class PersistentRoom implements AutoCloseable {
        private final Path file;
        private final RoomDirectory.Invitation invitation;
        private RoomDirectory rooms;
        private RoomDirectory.Room room;

        PersistentRoom(Path file) {
            this.file = file;
            rooms = new RoomDirectory(new SqliteRoomStore(file));
            try {
                invitation = rooms.create("Persistent credentials");
                room = rooms.authenticatedRoom(invitation.roomId(), invitation.token());
            } catch (RuntimeException | Error failure) {
                rooms.close();
                throw failure;
            }
        }

        RoomCredentials.Issued issue(RoomCredentials.Role role) {
            return rooms.issueCredential(room, role);
        }

        void revoke(RoomCredentials.Issued issued) {
            rooms.revokeCredential(room, issued.subject().id());
        }

        Optional<RoomCredentials.Subject> authenticate(String secret) {
            return rooms.authenticateCredential(room, secret);
        }

        long openTerminal() {
            return rooms.execute(
                    room,
                    operation ->
                            operation.changeIf(
                                    () -> true,
                                    draft -> {
                                        draft.rememberHost("computer", "Computer");
                                        return draft.openTerminal("computer");
                                    },
                                    terminal -> terminal.terminalId()));
        }

        void renameTerminal(long terminalId, String title) {
            rooms.execute(
                    room,
                    operation ->
                            operation.changeIf(
                                    () -> true,
                                    draft -> draft.renameTerminal(terminalId, title),
                                    result -> result));
        }

        void reopen() {
            rooms.close();
            rooms = new RoomDirectory(new SqliteRoomStore(file));
            room = rooms.authenticatedRoom(invitation.roomId(), invitation.token());
        }

        RoomDirectory.StoredRoom snapshot() {
            return room.durableState();
        }

        String storedJson() throws Exception {
            try (var connection =
                            DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
                    var statement = connection.createStatement();
                    var rows = statement.executeQuery("SELECT record_json FROM rooms")) {
                if (!rows.next()) throw new IllegalStateException("Stored room is missing");
                return rows.getString(1);
            }
        }

        @Override
        public void close() {
            rooms.close();
        }
    }
}

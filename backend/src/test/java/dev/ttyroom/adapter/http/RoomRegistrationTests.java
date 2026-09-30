package dev.ttyroom.adapter.http;

import static org.assertj.core.api.Assertions.assertThat;

import dev.ttyroom.application.RoomDirectory;
import dev.ttyroom.application.RoomSessions;
import dev.ttyroom.application.RoomStore;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

class RoomRegistrationTests {
    @Test
    void creatingARoomReturnsAPrivateManagerCredentialAfterOneAtomicSave() throws Exception {
        try (var server = new RegistrationServer()) {
            var response = server.post("/api/rooms", "{}", null);
            var body = response.body();
            var stored = server.store.records.get(body.path("roomId").asString());

            assertThat(response.status()).isEqualTo(201);
            assertThat(response.cacheControl()).isEqualTo("no-store");
            assertThat(body.path("managerCredential").asString()).matches("[A-Za-z0-9_-]{32}");
            assertThat(body.path("managerCredential").asString())
                    .isNotEqualTo(body.path("token").asString());
            assertThat(body.path("joinUrl").asString())
                    .endsWith("#" + body.path("token").asString());
            assertThat(body.path("joinUrl").asString())
                    .doesNotContain(body.path("managerCredential").asString());
            assertThat(server.store.writes).isEqualTo(1);
            assertThat(stored.credentials())
                    .singleElement()
                    .satisfies(
                            credential -> {
                                assertThat(credential.subject().role().name()).isEqualTo("MANAGER");
                                assertThat(credential.digest())
                                        .isNotEqualTo(body.path("managerCredential").asString());
                            });
        }
    }

    @Test
    void anInvitationRegistersDistinctParticipantsWithoutReplacingExistingSubjects()
            throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();

            var first = server.registerParticipant(room, room.token());
            var second = server.registerParticipant(room, room.token());
            var records = server.store.records.get(room.id()).credentials();

            assertIssued(first, "participantId");
            assertIssued(second, "participantId");
            assertThat(first.body().path("participantId"))
                    .isNotEqualTo(second.body().path("participantId"));
            assertThat(first.body().path("credential"))
                    .isNotEqualTo(second.body().path("credential"));
            assertThat(records)
                    .extracting(record -> record.subject().role().name())
                    .containsExactly("MANAGER", "PARTICIPANT", "PARTICIPANT");
            assertThat(records)
                    .extracting(record -> record.subject().id())
                    .contains(
                            first.body().path("participantId").asString(),
                            second.body().path("participantId").asString());
        }
    }

    @Test
    void theManagerCanRegisterAHostButTheInvitationCannot() throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var before = server.store.records.get(room.id());

            var denied = server.registerHost(room, room.token());
            var afterDenial = server.store.records.get(room.id());
            var registered = server.registerHost(room, room.manager());

            assertRejected(denied, 403, "registration forbidden");
            assertThat(afterDenial).isEqualTo(before);
            assertIssued(registered, "hostId");
            assertThat(server.store.records.get(room.id()).credentials())
                    .extracting(record -> record.subject().role().name())
                    .containsExactly("MANAGER", "HOST");
        }
    }

    @Test
    void anotherRoomsCredentialsCannotRegisterParticipantsOrHosts() throws Exception {
        try (var server = new RegistrationServer()) {
            var target = server.createRoom();
            var other = server.createRoom();
            var before = Map.copyOf(server.store.records);
            var writesBefore = server.store.writes;

            var participant = server.registerParticipant(target, other.token());
            var host = server.registerHost(target, other.manager());

            assertRejected(participant, 403, "registration forbidden");
            assertRejected(host, 403, "registration forbidden");
            assertThat(server.store.records).isEqualTo(before);
            assertThat(server.store.writes).isEqualTo(writesBefore);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"participantId", "hostId", "clientId", "role", "credential", "name"})
    void participantRequestsCannotChooseIdentityRoleOrUnspecifiedFields(String field)
            throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var writesBefore = server.store.writes;
            var body =
                    server.json
                            .createObjectNode()
                            .put("token", room.token())
                            .put(field, "attacker-value");

            var response =
                    server.post("/api/rooms/" + room.id() + "/participants", body.toString(), null);

            assertRejected(response, 400, "invalid registration request");
            assertThat(server.store.writes).isEqualTo(writesBefore);
        }
    }

    @Test
    void subjectCredentialsCannotRegisterHostsOrActAsInvitations() throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var participant = server.givenParticipant(room);
            var host = server.givenHost(room);
            var writesBefore = server.store.writes;

            var participantAsManager = server.registerHost(room, participant);
            var hostAsManager = server.registerHost(room, host);
            var managerAsInvitation = server.registerParticipant(room, room.manager());
            var participantAsInvitation = server.registerParticipant(room, participant);

            assertRejected(participantAsManager, 403, "registration forbidden");
            assertRejected(hostAsManager, 403, "registration forbidden");
            assertRejected(managerAsInvitation, 403, "registration forbidden");
            assertRejected(participantAsInvitation, 403, "registration forbidden");
            assertThat(server.store.writes).isEqualTo(writesBefore);
        }
    }

    @Test
    void failedRegistrationReturnsNoSecretAndKeepsTheCommittedRecords() throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var before = Map.copyOf(server.store.records);
            server.store.rejectWrites = true;

            var participant = server.registerParticipant(room, room.token());
            var host = server.registerHost(room, room.manager());
            var failedState = Map.copyOf(server.store.records);
            server.store.rejectWrites = false;
            var retry = server.registerHost(room, room.manager());

            assertRejected(participant, 503, "registration unavailable");
            assertRejected(host, 503, "registration unavailable");
            assertThat(failedState).isEqualTo(before);
            assertIssued(retry, "hostId");
            assertThat(server.store.records.get(room.id()).credentials()).hasSize(2);
        }
    }

    @Test
    void failedRoomCreationReturnsNoInvitationOrManagerAndStoresNothing() throws Exception {
        try (var server = new RegistrationServer()) {
            server.store.rejectWrites = true;

            var response = server.post("/api/rooms", "{}", null);

            assertRejected(response, 503, "registration unavailable");
            assertThat(server.store.records).isEmpty();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "null", "[]", "{\"token\":null}", "{\"token\":1}"})
    void malformedParticipantBodiesAreRejectedWithoutSaving(String body) throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var writesBefore = server.store.writes;

            var response = server.post("/api/rooms/" + room.id() + "/participants", body, null);

            assertRejected(response, 400, "invalid registration request");
            assertThat(server.store.writes).isEqualTo(writesBefore);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"hosts", "participants"})
    void registrationBodiesAreBoundedAndParserErrorsDoNotEchoInput(String endpoint)
            throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var writesBefore = server.store.writes;
            var path = "/api/rooms/" + room.id() + "/" + endpoint;

            var oversized = server.post(path, "x".repeat(16 * 1024 + 1), room.manager());
            var invalid = server.post(path, "{sensitive-invalid-body", room.manager());
            var trailing = server.post(path, "{} {}", room.manager());

            assertRejected(oversized, 400, "request body too large");
            assertRejected(invalid, 400, "invalid json");
            assertRejected(trailing, 400, "invalid json");
            assertThat(server.store.writes).isEqualTo(writesBefore);
        }
    }

    @Test
    void hostRegistrationRejectsMissingAuthorityAndClientChosenIdentity() throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var writesBefore = server.store.writes;

            var missing = server.registerHost(room, null);
            var chosen =
                    server.post(
                            "/api/rooms/" + room.id() + "/hosts",
                            "{\"hostId\":\"chosen\"}",
                            room.manager());
            var unknownRoom =
                    server.registerHost(
                            new Room("missing", room.token(), room.manager()), room.manager());

            assertRejected(missing, 403, "registration forbidden");
            assertRejected(chosen, 400, "invalid registration request");
            assertRejected(unknownRoom, 403, "registration forbidden");
            assertThat(server.store.writes).isEqualTo(writesBefore);
        }
    }

    @Test
    void theManagerCanRevokeARegisteredParticipant() throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var participant = server.registerParticipant(room, room.token());
            var subjectId = participant.body().path("participantId").asString();

            var response = server.revoke(room, "participants", subjectId, room.manager(), "");

            assertThat(response.status()).isEqualTo(204);
            assertThat(response.cacheControl()).isEqualTo("no-store");
            assertThat(server.store.records.get(room.id()).credentials())
                    .noneMatch(record -> record.subject().id().equals(subjectId));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"invitation", "participant", "host", "foreign", "missing"})
    void revocationRequiresThisRoomsManager(String authority) throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var participant = server.registerParticipant(room, room.token());
            var subjectId = participant.body().path("participantId").asString();
            var bearer =
                    switch (authority) {
                        case "invitation" -> room.token();
                        case "participant" -> participant.body().path("credential").asString();
                        case "host" -> server.givenHost(room);
                        case "foreign" -> server.createRoom().manager();
                        default -> null;
                    };
            var before = Map.copyOf(server.store.records);

            var response = server.revoke(room, "participants", subjectId, bearer, "{}");

            assertRejected(response, 403, "revocation forbidden");
            assertThat(server.store.records).isEqualTo(before);
        }
    }

    @Test
    void missingRoomsAreForbiddenAndWrongRoleOrAbsentSubjectsAreIdempotent() throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var participant = server.registerParticipant(room, room.token());
            var id = participant.body().path("participantId").asString();
            var managerId =
                    server.store.records.get(room.id()).credentials().getFirst().subject().id();
            var before = Map.copyOf(server.store.records);

            var missingRoom =
                    server.revoke(
                            new Room("missing", room.token(), room.manager()),
                            "participants",
                            id,
                            room.manager(),
                            "{}");
            var wrongRole = server.revoke(room, "hosts", id, room.manager(), "{}");
            var absent =
                    server.revoke(
                            room,
                            "participants",
                            java.util.UUID.randomUUID().toString(),
                            room.manager(),
                            "{}");
            var manager = server.revoke(room, "participants", managerId, room.manager(), "{}");

            assertRejected(missingRoom, 403, "revocation forbidden");
            assertThat(wrongRole.status()).isEqualTo(204);
            assertThat(absent.status()).isEqualTo(204);
            assertThat(manager.status()).isEqualTo(204);
            assertThat(server.store.records).isEqualTo(before);
        }
    }

    @Test
    void failedRevocationReturnsASanitizedErrorAndCanBeRetried() throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var host = server.registerHost(room, room.manager());
            var id = host.body().path("hostId").asString();
            var before = Map.copyOf(server.store.records);
            server.store.rejectWrites = true;

            var failed = server.revoke(room, "hosts", id, room.manager(), "{}");
            var afterFailure = Map.copyOf(server.store.records);
            server.store.rejectWrites = false;
            var retried = server.revoke(room, "hosts", id, room.manager(), "{}");
            var repeated = server.revoke(room, "hosts", id, room.manager(), "{}");

            assertRejected(failed, 503, "revocation unavailable");
            assertThat(afterFailure).isEqualTo(before);
            assertThat(retried.status()).isEqualTo(204);
            assertThat(repeated.status()).isEqualTo(204);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"null", "[]", "{\"credential\":\"secret\"}"})
    void revocationRejectsNonemptyOrNonobjectBodies(String body) throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var id = java.util.UUID.randomUUID().toString();
            var before = server.store.writes;

            var response = server.revoke(room, "participants", id, room.manager(), body);
            var malformedId =
                    server.revoke(room, "participants", "1-1-1-1-1", room.manager(), "{}");

            assertRejected(response, 400, "invalid revocation request");
            assertRejected(malformedId, 400, "invalid revocation request");
            assertThat(server.store.writes).isEqualTo(before);
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "createRoom",
                "registerParticipant",
                "registerHost",
                "revokeParticipant",
                "revokeHost"
            })
    void storageFailureMatchesTheOpenApiErrorExample(String operation) throws Exception {
        try (var server = new RegistrationServer()) {
            var room = server.createRoom();
            var participant =
                    server.registerParticipant(room, room.token())
                            .body()
                            .path("participantId")
                            .asString();
            var host = server.registerHost(room, room.manager()).body().path("hostId").asString();
            var expected = HttpSpecification.read().responseExample(operation, 503);
            server.store.rejectWrites = true;

            var response =
                    switch (operation) {
                        case "createRoom" -> server.post("/api/rooms", "{}", null);
                        case "registerParticipant" ->
                                server.registerParticipant(room, room.token());
                        case "registerHost" -> server.registerHost(room, room.manager());
                        case "revokeParticipant" ->
                                server.revoke(
                                        room, "participants", participant, room.manager(), "{}");
                        case "revokeHost" ->
                                server.revoke(room, "hosts", host, room.manager(), "{}");
                        default -> throw new IllegalArgumentException("Unknown operation");
                    };

            assertThat(response.status()).isEqualTo(503);
            assertThat(response.cacheControl()).isEqualTo(expected.cacheControl());
            assertThat(response.body()).isEqualTo(expected.body());
        }
    }

    private static void assertIssued(Response response, String identityField) {
        assertThat(response.status()).isEqualTo(201);
        assertThat(response.cacheControl()).isEqualTo("no-store");
        assertThat(response.body().propertyNames())
                .containsExactlyInAnyOrder(identityField, "credential");
        assertThat(response.body().path(identityField).asString())
                .matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
        assertThat(response.body().path("credential").asString()).matches("[A-Za-z0-9_-]{32}");
    }

    private static void assertRejected(Response response, int status, String reason) {
        assertThat(response.status()).isEqualTo(status);
        assertThat(response.cacheControl()).isEqualTo("no-store");
        assertThat(response.body().propertyNames()).containsExactly("error");
        assertThat(response.body().path("error").asString()).isEqualTo(reason);
    }

    private record Room(String id, String token, String manager) {
        @Override
        public String toString() {
            return "Room[id=" + id + ", secrets=<redacted>]";
        }
    }

    private record Response(int status, String cacheControl, JsonNode body) {}

    private static final class RegistrationServer implements AutoCloseable {
        final RecordingStore store = new RecordingStore();
        final RoomDirectory rooms = new RoomDirectory(store);
        final RoomSessions sessions = new RoomSessions(rooms);
        final JsonMapper json = JsonMapper.builder().build();
        final MockMvc http =
                MockMvcBuilders.standaloneSetup(new RoomController(rooms, sessions, json)).build();

        Response post(String path, String body, String bearer) throws Exception {
            var request =
                    org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(path)
                            .header("Host", "localhost")
                            .contentType("application/json")
                            .content(body);
            if (bearer != null) request.header("Authorization", "Bearer " + bearer);
            var response = http.perform(request).andReturn().getResponse();
            return new Response(
                    response.getStatus(),
                    response.getHeader("Cache-Control"),
                    json.readTree(response.getContentAsString()));
        }

        Response revoke(Room room, String kind, String id, String bearer, String body)
                throws Exception {
            var request =
                    org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(
                                    "/api/rooms/" + room.id() + "/" + kind + "/" + id)
                            .content(body);
            if (bearer != null) request.header("Authorization", "Bearer " + bearer);
            var response = http.perform(request).andReturn().getResponse();
            return new Response(
                    response.getStatus(),
                    response.getHeader("Cache-Control"),
                    response.getContentAsString().isEmpty()
                            ? null
                            : json.readTree(response.getContentAsString()));
        }

        Room createRoom() throws Exception {
            var response = post("/api/rooms", "{}", null);
            if (response.status() != 201) throw new IllegalStateException("Room fixture failed");
            return new Room(
                    response.body().path("roomId").asString(),
                    response.body().path("token").asString(),
                    response.body().path("managerCredential").asString());
        }

        Response registerParticipant(Room room, String token) throws Exception {
            return post(
                    "/api/rooms/" + room.id() + "/participants",
                    json.createObjectNode().put("token", token).toString(),
                    null);
        }

        Response registerHost(Room room, String manager) throws Exception {
            return post("/api/rooms/" + room.id() + "/hosts", "{}", manager);
        }

        String givenParticipant(Room room) throws Exception {
            return issuedSecret(registerParticipant(room, room.token()));
        }

        String givenHost(Room room) throws Exception {
            return issuedSecret(registerHost(room, room.manager()));
        }

        private String issuedSecret(Response response) {
            if (response.status() != 201)
                throw new IllegalStateException("Registration fixture failed");
            return response.body().path("credential").asString();
        }

        public void close() {
            sessions.close();
        }
    }

    private static final class RecordingStore implements RoomStore {
        final Map<String, RoomDirectory.StoredRoom> records = new LinkedHashMap<>();
        int writes;
        boolean rejectWrites;

        public List<RoomDirectory.StoredRoom> loadAll() {
            return List.copyOf(records.values());
        }

        public void save(RoomDirectory.StoredRoom room) {
            if (rejectWrites)
                throw new IllegalStateException(
                        "Controlled storage failure containing sensitive details");
            records.put(room.roomId(), room);
            writes++;
        }

        public void delete(String roomId) {
            records.remove(roomId);
        }

        public void close() {}
    }
}

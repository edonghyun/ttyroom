package dev.ttyroom.application;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

class RoomCredentialsTests {
    @ParameterizedTest
    @EnumSource(RoomCredentials.Role.class)
    void credentialResolvesOnlyItsServerIssuedRoleAndIdentity(RoomCredentials.Role role) {
        var room = new RoomCredentials();
        var issued = room.issue(role);

        var authenticated = room.authenticate(issued.secret());

        assertThat(authenticated).contains(issued.subject());
        assertThat(issued.subject().role()).isEqualTo(role);
    }

    @Test
    void anotherRoomCannotUseTheCredential() {
        var original = new RoomCredentials();
        var other = new RoomCredentials();
        var issued = original.issue(RoomCredentials.Role.HOST);

        var authenticated = other.authenticate(issued.secret());

        assertThat(authenticated).isEmpty();
    }

    @Test
    void revocationRejectsOnlyTheSelectedSubjectAndIsIdempotent() {
        var room = new RoomCredentials();
        var alice = room.issue(RoomCredentials.Role.PARTICIPANT);
        var bob = room.issue(RoomCredentials.Role.PARTICIPANT);

        room.revoke(alice.subject().id());
        room.revoke(alice.subject().id());
        var revoked = room.authenticate(alice.secret());
        var retained = room.authenticate(bob.secret());

        assertThat(revoked).isEmpty();
        assertThat(retained).contains(bob.subject());
    }

    @Test
    void publicIdentityAndMalformedSecretsCannotAuthenticate() {
        var room = new RoomCredentials();
        var issued = room.issue(RoomCredentials.Role.HOST);

        var byId = room.authenticate(issued.subject().id());
        var missing = room.authenticate(null);
        var empty = room.authenticate("");
        var unknown = room.authenticate("A".repeat(32));

        assertThat(byId).isEmpty();
        assertThat(missing).isEmpty();
        assertThat(empty).isEmpty();
        assertThat(unknown).isEmpty();
    }

    @Test
    void separateRegistrationsHaveDistinctIdsAndSecretsWithoutPrintingTheSecret() {
        var room = new RoomCredentials();

        var first = room.issue(RoomCredentials.Role.HOST);
        var second = room.issue(RoomCredentials.Role.HOST);

        assertThat(first.subject()).isNotEqualTo(second.subject());
        assertThat(first.secret()).matches("[A-Za-z0-9_-]{32}").isNotEqualTo(second.secret());
        assertThat(first.toString()).doesNotContain(first.secret()).contains("<redacted>");
    }
}

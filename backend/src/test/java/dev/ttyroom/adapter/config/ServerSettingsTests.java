package dev.ttyroom.adapter.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.env.MockEnvironment;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

class ServerSettingsTests {
    @TempDir Path directory;

    @Test
    void membershipCapacityUsesEnvironmentOverridesAndDefaults() throws Exception {
        var environment =
                configuredFile("{\"capacity\":{\"membershipsPerRoom\":3,\"memberships\":6}}")
                        .withProperty("TTYROOM_MAX_MEMBERSHIPS", "8");

        var settings = ServerSettings.load(environment);
        var defaults = ServerSettings.load(configuredFile("{}"));

        assertThat(settings.capacity().membershipsPerRoom()).isEqualTo(3);
        assertThat(settings.capacity().memberships()).isEqualTo(8);
        assertThat(defaults.capacity().membershipsPerRoom()).isEqualTo(64);
        assertThat(defaults.capacity().memberships()).isEqualTo(128);
    }

    @ParameterizedTest
    @ValueSource(strings = {"TTYROOM_MAX_MEMBERSHIPS", "TTYROOM_MAX_MEMBERSHIPS_PER_ROOM"})
    void zeroMembershipCapacityFailsStartup(String key) throws Exception {
        var environment = configuredFile("{}").withProperty(key, "0");

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void credentialCapacityUsesEnvironmentOverridesAndReachesTheStorageBoundary() throws Exception {
        var environment =
                configuredFile(
                                """
                                {"capacity":{"credentialsPerRoom":4,"credentials":6}}
                                """)
                        .withProperty("TTYROOM_MAX_CREDENTIALS", "8");

        var settings = ServerSettings.load(environment);
        var defaults = ServerSettings.load(configuredFile("{}"));

        assertThat(settings.capacity().credentialsPerRoom()).isEqualTo(4);
        assertThat(settings.capacity().credentials()).isEqualTo(8);
        assertThat(settings.roomLimits().credentialsPerRoom()).isEqualTo(4);
        assertThat(settings.roomLimits().credentials()).isEqualTo(8);
        assertThat(defaults.capacity().credentialsPerRoom()).isEqualTo(64);
        assertThat(defaults.capacity().credentials()).isEqualTo(128);
    }

    @ParameterizedTest
    @ValueSource(strings = {"TTYROOM_MAX_CREDENTIALS", "TTYROOM_MAX_CREDENTIALS_PER_ROOM"})
    void zeroCredentialCapacityFailsStartup(String key) throws Exception {
        var environment = configuredFile("{}").withProperty(key, "0");

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void capacityUsesEnvironmentThenFileThenDefaults() throws Exception {
        var environment =
                configuredFile(
                                """
                                {"capacity":{"rooms":2,"connections":3,"terminals":8,"retainedHistoryBytes":3145728}}
                                """)
                        .withProperty("TTYROOM_MAX_CONNECTIONS", "5");

        var settings = ServerSettings.load(environment);
        var defaults = ServerSettings.load(configuredFile("{}"));

        assertThat(settings.capacity().rooms()).isEqualTo(2);
        assertThat(settings.capacity().connections()).isEqualTo(5);
        assertThat(settings.capacity().terminals()).isEqualTo(8);
        assertThat(settings.capacity().retainedHistoryBytes()).isEqualTo(3145728);
        assertThat(settings.roomLimits().terminals()).isEqualTo(3);
        assertThat(defaults.capacity().rooms()).isEqualTo(4);
        assertThat(defaults.capacity().connections()).isEqualTo(16);
        assertThat(defaults.capacity().terminals()).isEqualTo(16);
        assertThat(defaults.capacity().retainedHistoryBytes()).isEqualTo(16777216);
    }

    @Test
    void historyReservationRoundsDownAndDisabledHistoryUsesOnlyTheTerminalCount() throws Exception {
        var tooSmall =
                configuredFile(
                        """
                        {"capacity":{"retainedHistoryBytes":1048575}}
                        """);
        var disabled =
                configuredFile(
                        """
                        {"policy":{"scrollbackBytesPerTerminal":0},"capacity":{"retainedHistoryBytes":0}}
                        """);

        var noRoomForHistory = ServerSettings.load(tooSmall).roomLimits();
        var withoutHistory = ServerSettings.load(disabled).roomLimits();

        assertThat(noRoomForHistory.terminals()).isZero();
        assertThat(withoutHistory.terminals()).isEqualTo(16);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "{\"rooms\":0}",
                "{\"connections\":-1}",
                "{\"terminals\":1.5}",
                "{\"retainedHistoryBytes\":-1}",
                "{\"unknown\":1}"
            })
    void invalidCapacityFailsStartup(String capacity) throws Exception {
        var environment = configuredFile("{\"capacity\":" + capacity + "}");

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void protocolSelectionUsesEnvironmentThenFileThenTheCredentialDefault() throws Exception {
        var fromFile = configuredFile("{\"protocolVersion\":8}");
        var overridden =
                configuredFile("{\"protocolVersion\":7}")
                        .withProperty("TTYROOM_PROTOCOL_VERSION", "8");
        var defaults = configuredFile("{}");

        var fileVersion = ServerSettings.load(fromFile).protocolVersion();
        var environmentVersion = ServerSettings.load(overridden).protocolVersion();
        var defaultVersion = ServerSettings.load(defaults).protocolVersion();

        assertThat(fileVersion).isEqualTo(8);
        assertThat(environmentVersion).isEqualTo(8);
        assertThat(defaultVersion).isEqualTo(8);
    }

    @Test
    void aConfigurationFileCanSelectTheCredentialProtocol() throws Exception {
        var environment = configuredFile("{\"protocolVersion\":8}");

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure).isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"6", "9", "", "true", "7.5"})
    void unsupportedProtocolSelectionFailsStartupInsteadOfFallingBack(String value)
            throws Exception {
        var environment = configuredFile("{}").withProperty("TTYROOM_PROTOCOL_VERSION", value);

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void environmentOverridesSelectedFileValuesWithoutDiscardingTheOthers() throws Exception {
        var environment =
                configuredFile(
                        """
                        {"port":1234,"statePath":"file.sqlite","policy":{
                          "participantGraceMs":20,"hostGraceMs":30,"scrollbackBytesPerTerminal":40,
                          "sendBufferDropThresholdBytes":50,"maxQueuedDataBytesPerConnection":60}}
                        """);
        environment
                .withProperty("TTYROOM_PORT", "5678")
                .withProperty("TTYROOM_STATE_PATH", "env.sqlite")
                .withProperty("TTYROOM_PARTICIPANT_GRACE_MS", "21")
                .withProperty("TTYROOM_SEND_BUFFER_DROP_THRESHOLD_BYTES", "51");

        var settings = ServerSettings.load(environment);

        assertThat(settings.port()).isEqualTo(5678);
        assertThat(settings.statePath()).isEqualTo("env.sqlite");
        assertThat(settings.participantGraceMs()).isEqualTo(21);
        assertThat(settings.hostGraceMs()).isEqualTo(30);
        assertThat(settings.scrollbackBytesPerTerminal()).isEqualTo(40);
        assertThat(settings.sendBufferDropThresholdBytes()).isEqualTo(51);
        assertThat(settings.maxQueuedDataBytesPerConnection()).isEqualTo(60);
    }

    @Test
    void emptyFileUsesSpringDefaults() throws Exception {
        var environment = configuredFile("{}");

        var settings = ServerSettings.load(environment);

        assertThat(settings.port()).isEqualTo(3000);
        assertThat(settings.statePath()).isEmpty();
        assertThat(settings.participantGraceMs()).isEqualTo(15000);
        assertThat(settings.hostGraceMs()).isEqualTo(30000);
        assertThat(settings.scrollbackBytesPerTerminal()).isEqualTo(1048576);
        assertThat(settings.sendBufferDropThresholdBytes()).isEqualTo(1048576);
        assertThat(settings.maxQueuedDataBytesPerConnection()).isEqualTo(1048576);
    }

    @Test
    void emptyEnvironmentStatePathExplicitlySelectsMemoryOverTheFile() throws Exception {
        var environment =
                configuredFile("{\"statePath\":\"file.sqlite\"}")
                        .withProperty("TTYROOM_STATE_PATH", "");

        var settings = ServerSettings.load(environment);

        assertThat(settings.statePath()).isEmpty();
    }

    @Test
    void environmentCanReplaceAnInvalidFileValueBeforeValidation() throws Exception {
        var environment =
                configuredFile("{\"port\":\"invalid\"}").withProperty("TTYROOM_PORT", "0");

        var settings = ServerSettings.load(environment);

        assertThat(settings.port()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", "NaN", "-1", "65536", "1.5", "true"})
    void invalidEnvironmentPortIsRejected(String value) throws Exception {
        var environment = configuredFile("{}").withProperty("TTYROOM_PORT", value);

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("port");
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("invalidFileSettings")
    void malformedOrUnknownFileSettingsAreRejectedWithoutEchoingTheirValues(
            String reason, String contents) throws Exception {
        var environment = configuredFile(contents);

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure).isInstanceOf(IllegalArgumentException.class);
        assertThat(failure).hasMessageNotContaining("secret-unknown-value");
    }

    @Test
    void anExplicitMissingFileIsNotSilentlyIgnored() {
        var environment =
                new MockEnvironment()
                        .withProperty(
                                "TTYROOM_CONFIG_PATH",
                                directory.resolve("missing.json").toString());

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("config file");
    }

    @Test
    void unsupportedConnectorRateOverrideIsRejectedInsteadOfPretendingToApplyIt() throws Exception {
        var environment =
                configuredFile("{}").withProperty("TTYROOM_OUTPUT_RATE_LIMIT_BYTES_PER_SEC", "1");

        var failure = catchThrowable(() -> ServerSettings.load(environment));

        assertThat(failure)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not supported");
    }

    @Test
    void zeroDisablesGraceHistoryAndLiveOutputWhileBinaryCapacityRemainsPositive()
            throws Exception {
        var environment =
                configuredFile(
                        """
                        {"policy":{"hostGraceMs":0,"participantGraceMs":0,"scrollbackBytesPerTerminal":0,
                        "sendBufferDropThresholdBytes":0,"maxQueuedDataBytesPerConnection":1,
                        "outputRateLimitBytesPerSec":4194304}}
                        """);

        var settings = ServerSettings.load(environment);

        assertThat(settings.port()).isEqualTo(3000);
        assertThat(settings.statePath()).isEmpty();
        assertThat(settings.participantGraceMs()).isZero();
        assertThat(settings.hostGraceMs()).isZero();
        assertThat(settings.scrollbackBytesPerTerminal()).isZero();
        assertThat(settings.sendBufferDropThresholdBytes()).isZero();
        assertThat(settings.maxQueuedDataBytesPerConnection()).isEqualTo(1);
    }

    private static Stream<Arguments> invalidFileSettings() {
        return Stream.of(
                Arguments.of("root must be an object", "[]"),
                Arguments.of("root cannot be null", "null"),
                Arguments.of("incomplete JSON", "{"),
                Arguments.of("trailing JSON", "{} {}"),
                Arguments.of("unknown root field", "{\"secret-unknown-value\":1}"),
                Arguments.of("policy must be an object", "{\"policy\":[]}"),
                Arguments.of("unknown policy field", "{\"policy\":{\"typo\":1}}"),
                Arguments.of("port must be numeric", "{\"port\":\"1234\"}"),
                Arguments.of("file state path cannot be blank", "{\"statePath\":\" \"}"),
                Arguments.of("grace cannot be negative", "{\"policy\":{\"hostGraceMs\":-1}}"),
                Arguments.of("grace cannot be null", "{\"policy\":{\"participantGraceMs\":null}}"),
                Arguments.of(
                        "history capacity must be integral",
                        "{\"policy\":{\"scrollbackBytesPerTerminal\":1.5}}"),
                Arguments.of(
                        "drop threshold must be numeric",
                        "{\"policy\":{\"sendBufferDropThresholdBytes\":true}}"),
                Arguments.of(
                        "binary capacity must be positive",
                        "{\"policy\":{\"maxQueuedDataBytesPerConnection\":0}}"),
                Arguments.of(
                        "grace must be a safe integer",
                        "{\"policy\":{\"hostGraceMs\":9007199254740992}}"));
    }

    private MockEnvironment configuredFile(String contents) throws Exception {
        var file = Files.createTempFile(directory, "settings-", ".json");
        Files.writeString(file, contents);
        return new MockEnvironment().withProperty("TTYROOM_CONFIG_PATH", file.toString());
    }
}

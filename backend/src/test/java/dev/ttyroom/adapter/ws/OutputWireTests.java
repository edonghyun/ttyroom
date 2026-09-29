package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.json.JsonMapper;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HexFormat;

class OutputWireTests {
    @Test
    void outputMatchesSharedV7BytesIncludingUnsignedMaximaAndUtf8() throws Exception {
        try (var input = getClass().getResourceAsStream("/protocol/wire-v7.json")) {
            var fixtures = JsonMapper.builder().build().readTree(input);
            for (var example : fixtures.get("binary")) {
                var expected = example.get("expected");
                if (!expected.get("kind").asString().equals("output")) continue;
                var bytes = HexFormat.of().parseHex(example.get("hex").asString());

                var frame = OutputWire.decode(ByteBuffer.wrap(bytes));

                assertThat(frame.terminalId()).isEqualTo(expected.get("terminalId").asLong());
                assertThat(frame.seq()).isEqualTo(expected.get("seq").asLong());
                assertThat(HexFormat.of().formatHex(frame.payload()))
                        .isEqualTo(expected.get("payloadHex").asString());
                assertThat(OutputWire.encode(frame)).containsExactly(bytes);
            }
            for (var malformed : fixtures.get("malformedBinary")) {
                assertThat(
                                OutputWire.decode(
                                        ByteBuffer.wrap(
                                                HexFormat.of().parseHex(malformed.asString()))))
                        .isNull();
            }
        }
    }

    @Test
    void decodeUsesTheReadableSliceWithoutChangingTheCallersPositionOrByteOrder() {
        var bytes = HexFormat.of().parseHex("00010000000780000000ff00");
        var buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        buffer.position(1);
        buffer.limit(bytes.length - 1);

        var frame = OutputWire.decode(buffer);

        assertThat(frame.terminalId()).isEqualTo(7);
        assertThat(frame.seq()).isEqualTo(2147483648L);
        assertThat(frame.payload()).containsExactly((byte) 255);
        assertThat(buffer.position()).isEqualTo(1);
        assertThat(buffer.order()).isEqualTo(ByteOrder.LITTLE_ENDIAN);
    }

    @Test
    void inputFramesAreNotMisinterpretedAsOutput() {
        var input = HexFormat.of().parseHex("0280000000ffffffffffffffff6c730d");

        assertThat(OutputWire.decode(ByteBuffer.wrap(input))).isNull();
    }
}

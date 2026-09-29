package dev.ttyroom.adapter.ws;

import static org.assertj.core.api.Assertions.assertThat;

import dev.ttyroom.application.InputFrame;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.json.JsonMapper;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HexFormat;

class InputWireTests {
    @Test
    void inputMatchesSharedV7BytesIncludingUnsignedMaxima() throws Exception {
        try (var input = getClass().getResourceAsStream("/protocol/wire-v7.json")) {
            var fixtures = JsonMapper.builder().build().readTree(input);
            for (var example : fixtures.get("binary")) {
                var expected = example.get("expected");
                if (!expected.get("kind").asString().equals("input")) continue;
                var bytes = HexFormat.of().parseHex(example.get("hex").asString());

                var frame = InputWire.decode(ByteBuffer.wrap(bytes));

                assertThat(frame.terminalId()).isEqualTo(expected.get("terminalId").asLong());
                assertThat(frame.seq()).isEqualTo(expected.get("seq").asLong());
                assertThat(frame.leaseId()).isEqualTo(expected.get("leaseId").asLong());
                assertThat(HexFormat.of().formatHex(frame.payload()))
                        .isEqualTo(expected.get("payloadHex").asString());
                assertThat(InputWire.encode(frame)).containsExactly(bytes);
            }
            for (var malformed : fixtures.get("malformedBinary"))
                assertThat(
                                InputWire.decode(
                                        ByteBuffer.wrap(
                                                HexFormat.of().parseHex(malformed.asString()))))
                        .isNull();
        }
    }

    @Test
    void inputOwnsItsBytesAndDecodePreservesTheCallersSliceAndOrder() {
        var source = new byte[] {0, (byte) 255};
        var frame = new InputFrame(7, 0xffffffffL, 0xffffffffL, source);
        source[0] = 42;
        frame.payload()[1] = 42;
        var wire = InputWire.encode(frame);
        var buffer = ByteBuffer.allocate(wire.length + 2).order(ByteOrder.LITTLE_ENDIAN);
        buffer.position(1);
        buffer.put(wire);
        buffer.limit(buffer.position());
        buffer.position(1);

        var decoded = InputWire.decode(buffer);

        assertThat(decoded.payload()).containsExactly((byte) 0, (byte) 255);
        assertThat(decoded.seq()).isEqualTo(0xffffffffL);
        assertThat(decoded.leaseId()).isEqualTo(0xffffffffL);
        assertThat(buffer.position()).isEqualTo(1);
        assertThat(buffer.order()).isEqualTo(ByteOrder.LITTLE_ENDIAN);
    }

    @Test
    void outputAndShortInputAreNotAcceptedAsInput() {
        assertThat(
                        InputWire.decode(
                                ByteBuffer.wrap(
                                        HexFormat.of().parseHex("01000000070000000100000000"))))
                .isNull();
        assertThat(
                        InputWire.decode(
                                ByteBuffer.wrap(
                                        HexFormat.of().parseHex("020000000700000001000000"))))
                .isNull();
    }
}

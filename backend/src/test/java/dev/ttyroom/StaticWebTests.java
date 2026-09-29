package dev.ttyroom;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class StaticWebTests {
    private static final String SCRIPT = "console.log(\"ttyroom fixture\");\n";
    @LocalServerPort int port;

    @ParameterizedTest
    @ValueSource(strings = {"/", "/r/room-1"})
    void entryRoutesServeUncachedHtmlWithTheExistingSecurityHeaders(String path) throws Exception {
        var response = request("GET", path);

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).contains("TTYRoom web fixture");
        assertThat(response.headers().firstValue("content-type").map(MediaType::parseMediaType))
                .hasValue(MediaType.parseMediaType("text/html; charset=utf-8"));
        assertThat(response.headers().firstValue("cache-control")).hasValue("no-store");
        assertThat(response.headers().firstValue("content-security-policy").orElseThrow())
                .contains(
                        "default-src 'self'",
                        "frame-ancestors 'none'",
                        "connect-src 'self' ws: wss:");
        assertThat(response.headers().firstValue("x-content-type-options")).hasValue("nosniff");
        assertThat(response.headers().firstValue("referrer-policy")).hasValue("no-referrer");
        assertThat(response.headers().firstValue("cross-origin-opener-policy"))
                .hasValue("same-origin");
    }

    @Test
    void aBuiltAssetHasItsMimeTypeAndImmutableCache() throws Exception {
        var response = request("GET", "/assets/fixture-Ab12.js");

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).isEqualTo(SCRIPT);
        assertThat(response.headers().firstValue("content-type").map(MediaType::parseMediaType))
                .hasValue(MediaType.parseMediaType("text/javascript; charset=utf-8"));
        assertThat(response.headers().firstValue("cache-control"))
                .hasValue("public, max-age=31536000, immutable");
    }

    @Test
    void headReturnsTheRepresentationLengthWithoutTheBody() throws Exception {
        var response = request("HEAD", "/assets/fixture-Ab12.js");

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).isEmpty();
        assertThat(response.headers().firstValue("content-length"))
                .hasValue(
                        String.valueOf(
                                SCRIPT.getBytes(java.nio.charset.StandardCharsets.UTF_8).length));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "/assets/missing.js",
                "/assets/nested/file.js",
                "/index.html",
                "/r/room/other",
                "/assets/config.txt"
            })
    void missingOrUnrecognizedResourcesNeverFallBackToHtml(String path) throws Exception {
        var response = request("GET", path);

        assertThat(response.statusCode()).isEqualTo(404);
        assertThat(response.body()).doesNotContain("TTYRoom web fixture");
    }

    @Test
    void theApiKeepsItsJsonErrorInsteadOfReceivingTheSpa() throws Exception {
        var response = request("GET", "/api/missing");

        assertThat(response.statusCode()).isEqualTo(404);
        assertThat(response.body()).isEqualTo("{\"error\":\"not found\"}");
    }

    private HttpResponse<String> request(String method, String path) throws Exception {
        try (var client = HttpClient.newHttpClient()) {
            return client.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                            .method(method, HttpRequest.BodyPublishers.noBody())
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
        }
    }
}

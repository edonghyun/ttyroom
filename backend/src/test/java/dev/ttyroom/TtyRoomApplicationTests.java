package dev.ttyroom;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class TtyRoomApplicationTests {
    @LocalServerPort int port;

    @Test
    void healthEndpointPreservesTheExistingHttpContract() throws Exception {
        try (var client = HttpClient.newHttpClient()) {
            var request =
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/healthz"))
                            .GET()
                            .build();

            var response = client.send(request, HttpResponse.BodyHandlers.ofString());

            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.body()).isEqualTo("ok");
            assertThat(response.headers().firstValue("content-type").orElseThrow())
                    .startsWith("text/plain");
        }
    }
}

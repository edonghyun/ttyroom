package dev.ttyroom.adapter.http;

import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Serves only the packaged SPA entry and flat Vite assets; never claims API or WS routes. */
@RestController
public final class StaticWebController {
    private static final Map<String, String> CONTENT_TYPES =
            Map.ofEntries(
                    Map.entry("css", "text/css; charset=utf-8"),
                    Map.entry("html", "text/html; charset=utf-8"),
                    Map.entry("js", "text/javascript; charset=utf-8"),
                    Map.entry("json", "application/json; charset=utf-8"),
                    Map.entry("map", "application/json; charset=utf-8"),
                    Map.entry("png", "image/png"),
                    Map.entry("svg", "image/svg+xml"),
                    Map.entry("woff", "font/woff"),
                    Map.entry("woff2", "font/woff2"));
    private static final String CSP =
            String.join(
                    "; ",
                    "default-src 'self'",
                    "base-uri 'none'",
                    "connect-src 'self' ws: wss:",
                    "font-src 'self'",
                    "form-action 'self'",
                    "frame-ancestors 'none'",
                    "img-src 'self' data:",
                    "object-src 'none'",
                    "script-src 'self'",
                    // React geometry and xterm apply runtime-computed inline styles.
                    "style-src 'self' 'unsafe-inline'");

    @GetMapping({"/", "/r/{roomId}"})
    public ResponseEntity<byte[]> entry() {
        return file("index.html", "text/html; charset=utf-8", "no-store");
    }

    @GetMapping("/assets/{name}")
    public ResponseEntity<byte[]> asset(@PathVariable String name) {
        if (!name.matches("[A-Za-z0-9._-]+")) return notFound();
        var extension =
                name.substring(name.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT);
        var type = CONTENT_TYPES.get(extension);
        if (type == null) return notFound();
        return file("assets/" + name, type, "public, max-age=31536000, immutable");
    }

    private ResponseEntity<byte[]> file(String name, String type, String cache) {
        try {
            var bytes = new ClassPathResource("web/" + name).getContentAsByteArray();
            return ResponseEntity.ok()
                    .headers(headers())
                    .header("Content-Type", type)
                    .header("Cache-Control", cache)
                    .contentLength(bytes.length)
                    .body(bytes);
        } catch (IOException missing) {
            return notFound();
        }
    }

    private ResponseEntity<byte[]> notFound() {
        return ResponseEntity.status(404)
                .headers(headers())
                .header("Cache-Control", "no-store")
                .header("Content-Type", "text/plain; charset=utf-8")
                .body("not found".getBytes(StandardCharsets.UTF_8));
    }

    private HttpHeaders headers() {
        var headers = new HttpHeaders();
        headers.set("Content-Security-Policy", CSP);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Content-Type-Options", "nosniff");
        return headers;
    }
}

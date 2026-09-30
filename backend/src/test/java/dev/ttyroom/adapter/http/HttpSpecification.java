package dev.ttyroom.adapter.http;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * Test fixture for route coverage and controlled storage failures; schema validation runs in TS.
 */
final class HttpSpecification {
    private static final Set<String> METHODS =
            Set.of("get", "put", "post", "delete", "options", "head", "patch", "trace");
    private final JsonNode document;

    private HttpSpecification(JsonNode document) {
        this.document = document;
    }

    static HttpSpecification read() throws Exception {
        try (var input = HttpSpecification.class.getResourceAsStream("/protocol/openapi.json")) {
            if (input == null)
                throw new IllegalStateException("HTTP specification resource missing");
            return new HttpSpecification(JsonMapper.builder().build().readTree(input));
        }
    }

    Set<String> routes() {
        var routes = new TreeSet<String>();
        for (var path : document.path("paths").propertyNames()) {
            for (var method : document.path("paths").path(path).propertyNames())
                if (METHODS.contains(method))
                    routes.add(method.toUpperCase(Locale.ROOT) + " " + path);
        }
        return routes;
    }

    ResponseExample responseExample(String operation, int status) {
        for (var path : document.path("paths")) {
            for (var method : METHODS) {
                var candidate = path.path(method);
                if (!candidate.path("operationId").asString().equals(operation)) continue;
                var response = resolve(candidate.path("responses").path(Integer.toString(status)));
                var header = resolve(response.path("headers").path("Cache-Control"));
                var body =
                        response.path("content")
                                .path("application/json")
                                .path("examples")
                                .path("example")
                                .path("value");
                if (body.isMissingNode())
                    throw new IllegalStateException("Response example missing");
                return new ResponseExample(header.path("schema").path("const").asString(), body);
            }
        }
        throw new IllegalStateException("Undocumented operation: " + operation);
    }

    // Only local references are permitted. Full OpenAPI validation belongs to the TS contract
    // guard.
    private JsonNode resolve(JsonNode value) {
        if (!value.has("$ref")) return value;
        var reference = value.path("$ref").asString();
        if (!reference.startsWith("#/"))
            throw new IllegalStateException("Expected local reference");
        var resolved = document.at(reference.substring(1));
        if (resolved.isMissingNode() || resolved.has("$ref"))
            throw new IllegalStateException("Expected a concrete local definition");
        return resolved;
    }

    record ResponseExample(String cacheControl, JsonNode body) {}
}

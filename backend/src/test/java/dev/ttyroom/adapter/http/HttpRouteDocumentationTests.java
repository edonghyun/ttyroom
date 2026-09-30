package dev.ttyroom.adapter.http;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.Set;
import java.util.TreeSet;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class HttpRouteDocumentationTests {
    @Autowired RequestMappingHandlerMapping routes;

    @Test
    void runningApplicationRoutesAndDocumentedRoutesMatchInBothDirections() throws Exception {
        var documented = HttpSpecification.read().routes();

        var implemented = new TreeSet<String>();
        for (var route : routes.getHandlerMethods().keySet()) {
            for (var path : route.getPatternValues()) {
                // Static assets, WS upgrades and the wildcard API fallback have separate contracts.
                if (!(path.startsWith("/api/") || path.equals("/healthz")) || path.contains("*"))
                    continue;
                var methods = route.getMethodsCondition().getMethods();
                if (methods.isEmpty()) methods = Set.of(RequestMethod.values());
                for (var method : methods) implemented.add(method.name() + " " + path);
            }
        }

        assertThat(documented).isEqualTo(implemented);
    }
}

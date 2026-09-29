package dev.ttyroom.adapter.http;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    @GetMapping(value = "/healthz", produces = "text/plain;charset=UTF-8")
    public String health() {
        return "ok";
    }
}

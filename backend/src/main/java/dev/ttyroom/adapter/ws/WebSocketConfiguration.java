package dev.ttyroom.adapter.ws;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.*;

@Configuration
@EnableWebSocket
public class WebSocketConfiguration implements WebSocketConfigurer {
    private final RoomSocketHandler handler;

    public WebSocketConfiguration(RoomSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // Preserve Node's origin policy; the room token is the sessions boundary.
        registry.addHandler(handler, "/ws").setAllowedOrigins("*");
    }
}

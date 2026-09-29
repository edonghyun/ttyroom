import { describe, expect, it } from "vitest";

import { RoomApi } from "./room-api.js";

describe("RoomApi — Quick Room HTTP boundary", () => {
  it("accepts only a complete create-room response", async () => {
    const validApi = new RoomApi({
      request: async () =>
        new Response(
          JSON.stringify({
            roomId: "room-1",
            name: "Payment Debug",
            token: "secret-token",
            joinUrl: "https://ttyroom.test/r/room-1#secret-token",
            managerCredential: "m".repeat(32),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(validApi.createRoom("Payment Debug")).resolves.toEqual({
      kind: "created",
      roomId: "room-1",
      name: "Payment Debug",
      token: "secret-token",
      joinUrl: "https://ttyroom.test/r/room-1#secret-token",
      managerCredential: "m".repeat(32),
    });

    const invalidApi = new RoomApi({
      request: async () =>
        new Response(JSON.stringify({ roomId: "room-1", token: "secret-token" }), {
          status: 201,
        }),
    });

    await expect(invalidApi.createRoom("Payment Debug")).resolves.toEqual({
      kind: "failed",
      reason: "invalid-response",
    });
  });
});

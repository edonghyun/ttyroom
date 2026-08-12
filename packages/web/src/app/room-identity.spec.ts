import { describe, expect, it } from "vitest";

import { RoomIdentity } from "./room-identity.js";

describe("RoomIdentity — per-Room browser identity", () => {
  it("keeps one generated client identity per Room and persists only identity metadata", () => {
    const storage = new Map<string, string>();
    const ids = ["client-1", "client-2"];
    const identity = new RoomIdentity({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
      createId: () => ids.shift() ?? "unexpected-id",
    });

    expect(identity.clientId("room-1")).toBe("client-1");
    expect(identity.clientId("room-1")).toBe("client-1");
    expect(identity.clientId("room-2")).toBe("client-2");

    identity.saveNickname("room-1", "Alice");

    expect(identity.nickname("room-1")).toBe("Alice");
    expect([...storage.values()].join(" ")).not.toContain("token");
  });
});

import { describe, expect, it, vi } from "vitest";
import { RoomManagement } from "./room-management.js";
import { RoomApi } from "./room-api.js";

function managementScenario() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const request = vi.fn(
    async () =>
      new Response(JSON.stringify({ hostId: "host", credential: "h".repeat(32) }), { status: 201 }),
  );
  const api = new RoomApi({ request });
  return { storage, request, api, management: new RoomManagement(storage, api) };
}

describe("room management authority", () => {
  it("retains manager authority after reload without using participant identity", async () => {
    const scenario = managementScenario();
    scenario.management.remember("room", "m".repeat(32));
    const reloaded = new RoomManagement(scenario.storage, scenario.api);

    const result = await reloaded.registerHost("room");

    expect(result.kind).toBe("registered");
    expect(scenario.request).toHaveBeenCalledWith(
      "/api/rooms/room/hosts",
      expect.objectContaining({
        headers: { "content-type": "application/json", Authorization: `Bearer ${"m".repeat(32)}` },
      }),
    );
  });

  it("does not send a registration request without the room's own manager credential", async () => {
    const scenario = managementScenario();
    scenario.management.remember("another-room", "m".repeat(32));

    const result = await scenario.management.registerHost("room");

    expect(result).toEqual({ kind: "unavailable" });
    expect(scenario.request).not.toHaveBeenCalled();
  });

  it("reports unavailable browser storage before navigation can lose the only manager credential", () => {
    const scenario = managementScenario();
    const management = new RoomManagement(
      {
        ...scenario.storage,
        setItem: () => {
          throw new Error("storage denied");
        },
      },
      scenario.api,
    );

    const remembered = management.remember("room", "m".repeat(32));

    expect(remembered).toBe(false);
  });
});

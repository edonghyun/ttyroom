import { describe, expect, it, vi } from "vitest";
import { RoomApi } from "./room-api.js";
import { RoomIdentity } from "./room-identity.js";

function registrationScenario() {
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
  let nextId = 0;
  const identity = () => new RoomIdentity({ storage, createId: () => `tab-${++nextId}` });
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ participantId: "server-participant", credential: "p".repeat(32) }),
        { status: 201 },
      ),
  );
  const api = new RoomApi({ request });
  return { identity, request, api, values };
}

describe("participant registration ownership", () => {
  it("registers once and reuses the credential after reload", async () => {
    const scenario = registrationScenario();
    const first = scenario.identity();

    const registered = await first.register("room", "invitation", scenario.api);
    const reloaded = await scenario.identity().register("room", "invitation", scenario.api);

    expect(registered).toEqual({
      kind: "registered",
      participantId: "server-participant",
      credential: "p".repeat(32),
    });
    expect(reloaded).toEqual(registered);
    expect(scenario.request).toHaveBeenCalledTimes(1);
    expect(scenario.request).toHaveBeenCalledWith(
      "/api/rooms/room/participants",
      expect.objectContaining({ body: JSON.stringify({ token: "invitation" }), cache: "no-store" }),
    );
    expect([...scenario.values.values()].join(" ")).not.toContain("invitation");
  });

  it("duplicate-tab renewal discards inherited admission but retains nickname", async () => {
    const scenario = registrationScenario();
    const identity = scenario.identity();
    identity.saveNickname("room", "Alice");
    await identity.register("room", "invitation", scenario.api);

    identity.renewClientId("room");
    await identity.register("room", "invitation", scenario.api);

    expect(scenario.request).toHaveBeenCalledTimes(2);
    expect(identity.nickname("room")).toBe("Alice");
  });

  it("coalesces concurrent joins into one registration", async () => {
    const scenario = registrationScenario();
    const identity = scenario.identity();

    const results = await Promise.all([
      identity.register("room", "invitation", scenario.api),
      identity.register("room", "invitation", scenario.api),
    ]);

    expect(scenario.request).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
  });

  it("does not cache failed registration and allows an explicit retry", async () => {
    const scenario = registrationScenario();
    scenario.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const identity = scenario.identity();

    const failed = await identity.register("room", "invitation", scenario.api);
    const retried = await identity.register("room", "invitation", scenario.api);

    expect(failed).toEqual({ kind: "failed", reason: "request-rejected" });
    expect(retried.kind).toBe("registered");
    expect(scenario.request).toHaveBeenCalledTimes(2);
  });

  it("uses the manager only as the host-registration bearer", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ hostId: "host", credential: "h".repeat(32) }), {
          status: 201,
        }),
    );
    const api = new RoomApi({ request });

    const result = await api.registerHost("room", "manager");

    expect(result).toEqual({ kind: "registered", hostId: "host", credential: "h".repeat(32) });
    expect(request).toHaveBeenCalledWith(
      "/api/rooms/room/hosts",
      expect.objectContaining({
        headers: { "content-type": "application/json", Authorization: "Bearer manager" },
        body: "{}",
        cache: "no-store",
      }),
    );
  });
});

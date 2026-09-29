import { describe, expect, it } from "vitest";

import { parseRoomRoute } from "./room-route.js";

describe("parseRoomRoute — Room invitation boundary", () => {
  it("keeps the fragment token opaque while recognizing an exact Room path", () => {
    expect(parseRoomRoute({ pathname: "/r/room-1", hash: "#secret%2Ftoken" })).toEqual({
      kind: "room",
      roomId: "room-1",
      token: "secret%2Ftoken",
    });
    expect(parseRoomRoute({ pathname: "/", hash: "" })).toEqual({ kind: "entry" });
    expect(parseRoomRoute({ pathname: "/r/room-1/extra", hash: "#secret" })).toEqual({
      kind: "entry",
    });
  });
});

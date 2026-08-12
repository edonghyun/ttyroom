import { describe, expect, it } from "vitest";
import { NoopSnapshotStore } from "./noop-snapshot-store.js";

describe("NoopSnapshotStore — 역할: 영속화 없는 SnapshotStore 어댑터 (MVP 기본)", () => {
  it("save는 아무것도 하지 않고 조용히 성공한다 (스모크)", () => {
    const store = new NoopSnapshotStore();
    expect(() =>
      store.save("r1", {
        roomId: "r1",
        name: "Quick Room",
        participants: [],
        hosts: [],
        terminals: [],
        leases: [],
      }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { protocolRoomFixture } from "./protocol-fixture.js";

describe("Protocol fixture — 수신 완료 경계", () => {
  it("입력을 이미 허용한 host에서도 두 번째 관찰을 완료한다", async () => {
    await using fixture = await protocolRoomFixture();
    await fixture.captureThroughInputCycle();

    const messages = await fixture.captureThroughInputCycle();

    expect(messages).toEqual([
      {
        type: "room-event",
        event: { kind: "host-input-state-changed", hostId: "host", remoteInputAllowed: false },
      },
      {
        type: "room-event",
        event: { kind: "host-input-state-changed", hostId: "host", remoteInputAllowed: true },
      },
    ]);
  });

  it("다른 host의 알림을 보존하고 대상 host의 완료까지 관찰한다", async () => {
    await using fixture = await protocolRoomFixture();
    const other = (await fixture.join("other", "host")).peer;
    other.send({ type: "host-input-state", remoteInputAllowed: true });
    other.send({ type: "host-inventory", terminals: [] });
    // Same-host reply proves the earlier input report was handled before capture begins.
    await other.next();

    const messages = await fixture.captureThroughInputCycle();

    expect(messages).toMatchObject([
      { event: { kind: "host-input-state-changed", hostId: "other", remoteInputAllowed: true } },
      { event: { kind: "host-connected", host: { hostId: "other" } } },
      { event: { kind: "host-input-state-changed", hostId: "host", remoteInputAllowed: true } },
    ]);
  });
});

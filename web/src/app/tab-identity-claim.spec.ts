import { describe, expect, it } from "vitest";

import { RoomIdentity, type IdentityStorage } from "./room-identity.js";
import { claimRoomIdentityForTab } from "./tab-identity-claim.js";

class FakeChannelHub {
  private readonly channels = new Map<string, Set<FakeChannel>>();

  create = (name: string): FakeChannel => {
    const channel = new FakeChannel(name, this);
    const channels = this.channels.get(name) ?? new Set();
    channels.add(channel);
    this.channels.set(name, channels);
    return channel;
  };

  send(sender: FakeChannel, message: unknown): void {
    for (const channel of this.channels.get(sender.name) ?? []) {
      if (channel !== sender) channel.receive(message);
    }
  }

  close(channel: FakeChannel): void {
    this.channels.get(channel.name)?.delete(channel);
  }
}

class FakeChannel {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(
    readonly name: string,
    private readonly hub: FakeChannelHub,
  ) {}

  postMessage(message: unknown): void {
    this.hub.send(this, message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.hub.close(this);
  }

  receive(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent<unknown>);
  }
}

function mapStorage(values: Map<string, string>): IdentityStorage {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("claimRoomIdentityForTab", () => {
  it("keeps a lone tab identity stable across startup", async () => {
    const hub = new FakeChannelHub();
    const identity = new RoomIdentity({
      storage: mapStorage(new Map()),
      createId: () => "client-1",
    });

    const claim = await claimRoomIdentityForTab("room-1", identity, {
      createTabId: () => "tab-1",
      createChannel: hub.create,
      waitForResponses: async () => undefined,
    });

    expect(claim.identity.clientId("room-1")).toBe("client-1");
    claim.dispose();
  });

  it("renews only the copied tab identity while preserving its nickname", async () => {
    const hub = new FakeChannelHub();
    const originalStorage = new Map<string, string>();
    const original = new RoomIdentity({
      storage: mapStorage(originalStorage),
      createId: () => "client-1",
    });
    original.saveNickname("room-1", "Alice");
    const originalClaim = await claimRoomIdentityForTab("room-1", original, {
      createTabId: () => "tab-1",
      createChannel: hub.create,
      waitForResponses: async () => undefined,
    });

    const copiedStorage = new Map(originalStorage);
    const copied = new RoomIdentity({
      storage: mapStorage(copiedStorage),
      createId: () => "client-2",
    });
    const copiedClaim = await claimRoomIdentityForTab("room-1", copied, {
      createTabId: () => "tab-2",
      createChannel: hub.create,
      waitForResponses: async () => undefined,
    });

    expect(originalClaim.identity.clientId("room-1")).toBe("client-1");
    expect(copiedClaim.identity.clientId("room-1")).toBe("client-2");
    expect(copiedClaim.identity.nickname("room-1")).toBe("Alice");
    originalClaim.dispose();
    copiedClaim.dispose();
  });
});

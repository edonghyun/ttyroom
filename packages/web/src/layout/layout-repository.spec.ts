import { describe, expect, it } from "vitest";

import { LayoutRepository } from "./layout-repository.js";

describe("LayoutRepository — participant-local window persistence", () => {
  it("isolates layouts by versioned Room, client, and viewport bucket key", () => {
    const storage = new MemoryLayoutStorage();
    const repository = new LayoutRepository({ storage });
    const scope = { roomId: "room-1", clientId: "alice-id", viewportBucket: "1280x800" };
    const layout = {
      terminalId: 1,
      x: 40,
      y: 30,
      width: 640,
      height: 480,
      z: 1,
      state: "floating" as const,
    };

    repository.save(scope, [layout]);

    expect(repository.load(scope)).toEqual([layout]);
    expect(
      repository.load({ ...scope, clientId: "bob-id" }),
    ).toEqual([]);
    expect(storage.keys()).toEqual(["ttyroom:layout:v1:room-1:alice-id:1280x800"]);
  });

  it("returns an empty layout for malformed or obsolete stored data", () => {
    const storage = new MemoryLayoutStorage();
    const repository = new LayoutRepository({ storage });
    const scope = { roomId: "room-1", clientId: "alice-id", viewportBucket: "1280x800" };
    const key = "ttyroom:layout:v1:room-1:alice-id:1280x800";

    storage.setItem(key, "{not-json");
    expect(repository.load(scope)).toEqual([]);

    storage.setItem(key, JSON.stringify({ version: 0, windows: [] }));
    expect(repository.load(scope)).toEqual([]);
  });

  it("prunes a removed terminal from its participant layout", () => {
    const storage = new MemoryLayoutStorage();
    const repository = new LayoutRepository({ storage });
    const scope = { roomId: "room-1", clientId: "alice-id", viewportBucket: "1280x800" };
    repository.save(scope, [layoutOf(1), layoutOf(2)]);

    repository.pruneTerminal(scope, 1);

    expect(repository.load(scope)).toEqual([layoutOf(2)]);
  });

  it("clears only layout keys belonging to a Room that is gone", () => {
    const storage = new MemoryLayoutStorage();
    const repository = new LayoutRepository({ storage });
    const scope = { roomId: "room-1", clientId: "alice-id", viewportBucket: "1280x800" };
    repository.save(scope, [layoutOf(1)]);
    repository.save({ ...scope, clientId: "bob-id" }, [layoutOf(2)]);
    repository.save({ ...scope, roomId: "room-2" }, [layoutOf(3)]);

    repository.clearRoom("room-1");

    expect(storage.keys()).toEqual(["ttyroom:layout:v1:room-2:alice-id:1280x800"]);
  });

  it("persists only window geometry and never identity, token, or output fields", () => {
    const storage = new MemoryLayoutStorage();
    const repository = new LayoutRepository({ storage });
    const scope = { roomId: "room-1", clientId: "alice-id", viewportBucket: "1280x800" };
    const polluted = {
      ...layoutOf(1),
      token: "secret-token",
      nickname: "Alice",
      output: "terminal secret",
    };

    repository.save(scope, [polluted]);

    const persisted = storage.getItem("ttyroom:layout:v1:room-1:alice-id:1280x800") ?? "";
    expect(persisted).not.toContain("secret-token");
    expect(persisted).not.toContain("Alice");
    expect(persisted).not.toContain("terminal secret");
    expect(repository.load(scope)).toEqual([layoutOf(1)]);
  });
});

function layoutOf(terminalId: number) {
  return {
    terminalId,
    x: 40,
    y: 30,
    width: 640,
    height: 480,
    z: terminalId,
    state: "floating" as const,
  };
}

class MemoryLayoutStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

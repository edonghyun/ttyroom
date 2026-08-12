import type { RoomSnapshot } from "@ttyroom/protocol";
import type { SnapshotStore } from "../../ports/snapshot-store.js";

export class NoopSnapshotStore implements SnapshotStore {
  save(_roomId: string, _snapshot: RoomSnapshot): void {
    // 의도된 no-op — 메모리가 authoritative, 영속화는 SQLite 어댑터의 몫
  }
}

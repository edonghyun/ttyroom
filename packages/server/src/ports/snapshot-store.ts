import type { RoomSnapshot } from "@ttyroom/protocol";

// 라이브 상태 저장소가 아니라 스냅샷 영속화 전용 — 메모리가 authoritative.
// SQLite 어댑터를 붙이면 서버 재시작 복구와 Team Room이 열린다.
export interface SnapshotStore {
  save(roomId: string, snapshot: RoomSnapshot): void;
}

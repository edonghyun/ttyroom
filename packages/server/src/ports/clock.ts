export type CancelTimer = () => void;

// 코어는 "N ms 뒤 이 이벤트"만 요청한다 — 실제 시간 진행은 어댑터(또는 FakeClock)가 소유
export interface Clock {
  schedule(delayMs: number, fn: () => void): CancelTimer;
}

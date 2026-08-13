export interface Policy {
  participantGraceMs: number;
  hostGraceMs: number;
  scrollbackBytesPerTerminal: number;
  sendBufferDropThresholdBytes: number;
  maxQueuedDataBytesPerConnection: number;
  outputRateLimitBytesPerSec: number;
}

// 수치 근거는 스펙 "설정 계층" 참조 — 유예는 모바일 네트워크 순단 흡수,
// 버퍼·rate limit은 1MiB 스크롤백과 4MiB/s 출력 상한(스펙 고정값)
export const DEFAULT_POLICY: Policy = {
  participantGraceMs: 15000,
  hostGraceMs: 30000,
  scrollbackBytesPerTerminal: 1048576,
  sendBufferDropThresholdBytes: 1048576,
  maxQueuedDataBytesPerConnection: 1048576,
  outputRateLimitBytesPerSec: 4194304,
};

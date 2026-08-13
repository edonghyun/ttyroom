import type { CancelTimer, Clock, TimerTask } from "../ports/clock.js";

// 유예 체인(단절→유예→해제 등)은 깊이가 한 자릿수다 — 10_000이면 정상 시나리오와
// 자기 재등록 폭주를 확실히 가른다. 초과는 테스트 대상 코드의 버그로 보고 진단 throw.
const MAX_FIRED_PER_ADVANCE = 10_000;

interface PendingTimer {
  at: number;
  task: TimerTask;
  cancelled: boolean;
  fired: boolean;
}

export class FakeClock implements Clock {
  private readonly timers: PendingTimer[] = [];
  private now = 0;

  schedule(delayMs: number, task: TimerTask): CancelTimer {
    const timer: PendingTimer = { at: this.now + delayMs, task, cancelled: false, fired: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;

    // 실시간 의미론: due 시각 오름차순으로 발화하고, 콜백 실행 시점의 now는 그 타이머의
    // due 시각이다 — 콜백이 등록한 새 타이머(유예 체인)도 target 안이면 같은 advance에서 발화한다.
    let firedCount = 0;
    let next = this.nextDueTimer(target);
    while (next) {
      firedCount += 1;
      if (firedCount > MAX_FIRED_PER_ADVANCE) {
        // 동기 무한 루프는 vitest 타임아웃도 못 끊는다 — 여기서 진단하고 크게 실패시킨다
        throw new Error(
          `한 advance에서 실행된 타이머가 상한(${MAX_FIRED_PER_ADVANCE})을 넘었다 — ` +
            "콜백이 delay 0으로 자기 자신을 재등록하고 있는지 확인하라",
        );
      }

      this.now = next.at;
      next.fired = true;
      await next.task();
      next = this.nextDueTimer(target);
    }

    this.now = target;
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled && !t.fired).length;
  }

  private nextDueTimer(target: number): PendingTimer | undefined {
    // due 시각 오름차순, 같은 시각은 등록 순서(삽입 순서 순회 + 엄격 미만 교체)
    let earliest: PendingTimer | undefined;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.fired || timer.at > target) continue;
      if (!earliest || timer.at < earliest.at) earliest = timer;
    }
    return earliest;
  }
}

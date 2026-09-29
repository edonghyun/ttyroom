export type CancelTimer = () => void;
export type TimerTask = () => void | Promise<void>;

export interface Clock {
  schedule(delayMs: number, task: TimerTask): CancelTimer;
}

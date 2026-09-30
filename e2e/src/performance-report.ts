export interface Timing {
  operation: string;
  startedAtMs: number;
  elapsedMs: number;
  succeeded: boolean;
}

/** Owns raw observations; a failed operation must remain visible to the report. */
export class Timings {
  readonly samples: Timing[] = [];

  async measure<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let succeeded = false;
    try {
      const result = await action();
      succeeded = true;
      return result;
    } finally {
      this.samples.push({
        operation,
        startedAtMs: start,
        elapsedMs: performance.now() - start,
        succeeded,
      });
    }
  }
}

export function distribution(samples: readonly Timing[]) {
  const values = samples.filter((sample) => sample.succeeded).map((sample) => sample.elapsedMs);
  values.sort((a, b) => a - b);
  const percentile = (fraction: number) => values[Math.ceil(values.length * fraction) - 1] ?? null;
  return {
    succeeded: values.length,
    failed: samples.length - values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: values.at(-1) ?? null,
  };
}

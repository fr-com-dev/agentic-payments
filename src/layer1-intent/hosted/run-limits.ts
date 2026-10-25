// L1-6 per-requester run limits (SPEC.md §11 SEC-14; specs/011 contracts/access-and-sessions.md, research R8).
// In memory: exact while the agent service runs as one replica (`maxReplicas: 1`).
export const MAX_CONCURRENT_RUNS = 2;
export const MAX_STARTS_PER_HOUR = 20;
export const WINDOW_MS = 3_600_000;
/** Retry-After for a concurrency refusal: a slot frees when a run ends, which is usually seconds away. */
export const CONCURRENCY_RETRY_AFTER_SEC = 5;

export interface RunLimiter {
  /** Seconds to wait (the Retry-After value), or null when a new run may start now. */
  check(key: string): number | null;
  /** Records a start. The returned release is safe to call more than once. */
  start(key: string): () => void;
}

export function createRunLimiter(o: { maxConcurrent?: number; maxStartsPerHour?: number; now?: () => number } = {}): RunLimiter {
  const maxConcurrent = o.maxConcurrent ?? MAX_CONCURRENT_RUNS;
  const maxStarts = o.maxStartsPerHour ?? MAX_STARTS_PER_HOUR;
  const now = o.now ?? Date.now;
  const active = new Map<string, number>();
  const starts = new Map<string, number[]>();

  const recent = (key: string, t: number): number[] => {
    const list = (starts.get(key) ?? []).filter((s) => t - s < WINDOW_MS);
    if (list.length > 0) starts.set(key, list);
    else starts.delete(key);
    return list;
  };

  return {
    check(key) {
      const t = now();
      if ((active.get(key) ?? 0) >= maxConcurrent) return CONCURRENCY_RETRY_AFTER_SEC;
      const list = recent(key, t);
      if (list.length >= maxStarts) return Math.max(1, Math.ceil((list[0]! + WINDOW_MS - t) / 1000));
      return null;
    },
    start(key) {
      const t = now();
      starts.set(key, [...recent(key, t), t]);
      active.set(key, (active.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (active.get(key) ?? 1) - 1;
        if (n > 0) active.set(key, n);
        else active.delete(key);
      };
    },
  };
}

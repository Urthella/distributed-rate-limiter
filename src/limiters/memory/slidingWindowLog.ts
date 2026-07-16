import type { RateLimitDecision, RateLimiter } from '../../types';

/**
 * Sliding Window Log (in-memory).
 *
 * Keeps a timestamp per allowed request and counts how many fall inside the
 * trailing window. Exact — no boundary bursts — at the cost of O(limit)
 * memory per key. Expired entries are pruned on every check; denied requests
 * are NOT recorded (they don't extend the client's penalty).
 */
export class SlidingWindowLogMemoryLimiter implements RateLimiter {
  private logs = new Map<string, number[]>();
  private lastSweepMs = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const nowMs = this.now();
    this.maybeSweep(nowMs);

    const cutoff = nowMs - this.windowMs;
    let log = this.logs.get(key) ?? [];

    // Prune timestamps that fell out of the trailing window.
    let firstLive = 0;
    while (firstLive < log.length && log[firstLive] <= cutoff) firstLive++;
    if (firstLive > 0) log = log.slice(firstLive);

    let allowed = false;
    if (log.length < this.limit) {
      log.push(nowMs);
      allowed = true;
    }
    this.logs.set(key, log);

    const oldest = log[0];
    const resetMs = oldest !== undefined ? oldest + this.windowMs : nowMs + this.windowMs;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - log.length),
      resetSeconds: Math.ceil(resetMs / 1000),
      retryAfterSeconds: allowed ? undefined : Math.max(1, Math.ceil((resetMs - nowMs) / 1000)),
    };
  }

  /** Prune all logs and drop empty ones so idle keys do not leak memory. */
  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < Math.max(this.windowMs, 30_000)) return;
    this.lastSweepMs = nowMs;
    const cutoff = nowMs - this.windowMs;
    for (const [key, log] of this.logs) {
      const live = log.filter((t) => t > cutoff);
      if (live.length === 0) this.logs.delete(key);
      else this.logs.set(key, live);
    }
  }

  /** Exposed for tests: number of retained timestamps for a key. */
  logSize(key: string): number {
    return this.logs.get(key)?.length ?? 0;
  }

  dispose(): void {
    this.logs.clear();
  }
}

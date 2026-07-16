import type { RateLimitDecision, RateLimiter } from '../../types';

interface WindowEntry {
  windowId: number;
  count: number;
}

/**
 * Fixed Window Counter (in-memory).
 *
 * Time is divided into fixed windows of `windowMs`; every request in the same
 * window increments one counter. O(1) memory per key, but permits up to 2x the
 * limit in a burst straddling a window boundary (documented in the README).
 */
export class FixedWindowMemoryLimiter implements RateLimiter {
  private counters = new Map<string, WindowEntry>();
  private lastSweepMs = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const nowMs = this.now();
    const windowId = Math.floor(nowMs / this.windowMs);
    this.maybeSweep(nowMs, windowId);

    let entry = this.counters.get(key);
    if (!entry || entry.windowId !== windowId) {
      entry = { windowId, count: 0 };
      this.counters.set(key, entry);
    }
    entry.count += 1;

    const allowed = entry.count <= this.limit;
    const resetMs = (windowId + 1) * this.windowMs;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetSeconds: Math.ceil(resetMs / 1000),
      retryAfterSeconds: allowed ? undefined : Math.max(1, Math.ceil((resetMs - nowMs) / 1000)),
    };
  }

  /** Drop counters from past windows so idle keys do not leak memory. */
  private maybeSweep(nowMs: number, currentWindowId: number): void {
    if (nowMs - this.lastSweepMs < Math.max(this.windowMs, 30_000)) return;
    this.lastSweepMs = nowMs;
    for (const [key, entry] of this.counters) {
      if (entry.windowId < currentWindowId) this.counters.delete(key);
    }
  }

  dispose(): void {
    this.counters.clear();
  }
}

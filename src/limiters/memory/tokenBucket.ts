import type { RateLimitDecision, RateLimiter } from '../../types';

interface Bucket {
  /** Fractional token count — refill accrues continuously. */
  tokens: number;
  /** Last refill timestamp in ms. */
  lastMs: number;
}

/**
 * Token Bucket (in-memory).
 *
 * A bucket holds up to `capacity` tokens and refills continuously at
 * `refillPerSecond`. Each request consumes one token; an empty bucket denies.
 * Allows short bursts up to `capacity` while enforcing the sustained rate.
 * Refill is fractional (e.g. 0.5 tokens/sec works correctly).
 */
export class TokenBucketMemoryLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweepMs = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const nowMs = this.now();
    this.maybeSweep(nowMs);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastMs: nowMs };
      this.buckets.set(key, bucket);
    }

    const elapsedMs = Math.max(0, nowMs - bucket.lastMs);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsedMs * this.refillPerSecond) / 1000);
    bucket.lastMs = nowMs;

    let allowed = false;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    }

    const msToFull = ((this.capacity - bucket.tokens) / this.refillPerSecond) * 1000;
    const retryMs = allowed ? 0 : ((1 - bucket.tokens) / this.refillPerSecond) * 1000;
    return {
      allowed,
      limit: this.capacity,
      remaining: Math.floor(bucket.tokens),
      resetSeconds: Math.ceil((nowMs + msToFull) / 1000),
      retryAfterSeconds: allowed ? undefined : Math.max(1, Math.ceil(retryMs / 1000)),
    };
  }

  /** Drop buckets that have been idle long enough to be full again. */
  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < 60_000) return;
    this.lastSweepMs = nowMs;
    const idleMs = (this.capacity / this.refillPerSecond) * 1000 + 60_000;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.lastMs > idleMs) this.buckets.delete(key);
    }
  }

  dispose(): void {
    this.buckets.clear();
  }
}

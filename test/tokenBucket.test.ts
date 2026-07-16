import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucketMemoryLimiter } from '../src/limiters/memory/tokenBucket';

const T0 = 1_767_225_600_000;

describe('TokenBucketMemoryLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a burst up to capacity, then denies', async () => {
    const limiter = new TokenBucketMemoryLimiter(3, 1);
    expect((await limiter.check('k')).remaining).toBe(2);
    expect((await limiter.check('k')).remaining).toBe(1);
    expect((await limiter.check('k')).remaining).toBe(0);
    const denied = await limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(3);
    expect(denied.retryAfterSeconds).toBe(1); // 1 token / 1 per second
  });

  it('refills at the configured rate', async () => {
    const limiter = new TokenBucketMemoryLimiter(3, 1);
    for (let i = 0; i < 3; i++) await limiter.check('k');
    expect((await limiter.check('k')).allowed).toBe(false);

    vi.setSystemTime(T0 + 1_000); // +1 token
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(false); // spent again
  });

  it('accrues fractional refill correctly', async () => {
    const limiter = new TokenBucketMemoryLimiter(2, 1);
    await limiter.check('k');
    await limiter.check('k'); // bucket empty at T0

    vi.setSystemTime(T0 + 500); // 0.5 tokens — not enough
    expect((await limiter.check('k')).allowed).toBe(false);

    vi.setSystemTime(T0 + 1_000); // fraction accumulates to a full token
    expect((await limiter.check('k')).allowed).toBe(true);
  });

  it('supports refill rates below one token per second', async () => {
    const limiter = new TokenBucketMemoryLimiter(1, 0.5); // one token every 2s
    expect((await limiter.check('k')).allowed).toBe(true);
    vi.setSystemTime(T0 + 1_000);
    const denied = await limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    vi.setSystemTime(T0 + 2_000);
    expect((await limiter.check('k')).allowed).toBe(true);
  });

  it('clamps stored tokens at capacity (no unlimited accrual while idle)', async () => {
    const limiter = new TokenBucketMemoryLimiter(3, 1);
    await limiter.check('k');
    vi.setSystemTime(T0 + 3_600_000); // idle for an hour
    let allowedCount = 0;
    for (let i = 0; i < 10; i++) {
      if ((await limiter.check('k')).allowed) allowedCount++;
    }
    expect(allowedCount).toBe(3); // burst capped at capacity
  });

  it('reset header reflects time until the bucket is full', async () => {
    const limiter = new TokenBucketMemoryLimiter(2, 1);
    const first = await limiter.check('k'); // 1 token left -> full in 1s
    expect(first.resetSeconds).toBe(Math.ceil((T0 + 1_000) / 1000));
  });
});

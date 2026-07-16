import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { RedisFixedWindowLimiter } from '../src/limiters/redis/fixedWindow';
import { RedisTokenBucketLimiter } from '../src/limiters/redis/tokenBucket';
import { RedisSlidingWindowLogLimiter } from '../src/limiters/redis/slidingWindowLog';
import type { RedisScriptRunner } from '../src/limiters/redis/runScript';

const REDIS_URL = process.env.REDIS_URL;

/**
 * Real-Redis integration tests. SKIPPED unless REDIS_URL is set, e.g.:
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 * Verifies the actual Lua scripts (atomicity, server TIME, TTLs) against a
 * live server. Keys are unique per run and expire on their own.
 */
describe.skipIf(!REDIS_URL)('Redis integration (requires REDIS_URL)', () => {
  let client: Redis;
  let runner: RedisScriptRunner;
  const runId = `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  beforeAll(() => {
    client = new Redis(REDIS_URL!);
    runner = client as unknown as RedisScriptRunner;
  });

  afterAll(async () => {
    await client.quit();
  });

  it('fixed window enforces the limit atomically', async () => {
    const limiter = new RedisFixedWindowLimiter(runner, 3, 60_000, `test:${runId}:fw`);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => limiter.check('client')),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(3); // atomic even under concurrency
    const denied = results.find((r) => !r.allowed)!;
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('token bucket bursts to capacity then denies', async () => {
    const limiter = new RedisTokenBucketLimiter(runner, 2, 0.5, `test:${runId}:tb`);
    expect((await limiter.check('client')).allowed).toBe(true);
    expect((await limiter.check('client')).allowed).toBe(true);
    const denied = await limiter.check('client');
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(2);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('sliding window log enforces the limit and reports reset', async () => {
    const limiter = new RedisSlidingWindowLogLimiter(runner, 2, 60_000, `test:${runId}:sw`);
    expect((await limiter.check('client')).allowed).toBe(true);
    expect((await limiter.check('client')).allowed).toBe(true);
    const denied = await limiter.check('client');
    expect(denied.allowed).toBe(false);
    expect(denied.resetSeconds).toBeGreaterThan(Date.now() / 1000 - 5);
  });
});

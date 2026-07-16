import { beforeEach, describe, expect, it } from 'vitest';
import { RedisFixedWindowLimiter } from '../src/limiters/redis/fixedWindow';
import { RedisTokenBucketLimiter } from '../src/limiters/redis/tokenBucket';
import { RedisSlidingWindowLogLimiter } from '../src/limiters/redis/slidingWindowLog';
import { FakeRedis } from './helpers/fakeRedis';

/**
 * Redis-backed limiters exercised against an in-process fake of the
 * EVAL/EVALSHA surface (see helpers/fakeRedis.ts). Real-server parity is
 * covered by redisIntegration.test.ts when REDIS_URL is provided.
 */
describe('Redis-backed limiters (stubbed eval)', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    // Align the fake clock to a window boundary for deterministic assertions.
    redis.nowMs = 1_700_000_000_000;
  });

  describe('EVALSHA / EVAL fallback protocol', () => {
    it('falls back to EVAL on NOSCRIPT, then uses EVALSHA', async () => {
      const limiter = new RedisFixedWindowLimiter(redis, 5, 10_000);
      await limiter.check('client-1');
      // First call: EVALSHA -> NOSCRIPT -> EVAL (loads script).
      expect(redis.evalshaCalls).toBe(1);
      expect(redis.evalCalls).toBe(1);

      await limiter.check('client-1');
      // Second call: EVALSHA succeeds, no further EVAL.
      expect(redis.evalshaCalls).toBe(2);
      expect(redis.evalCalls).toBe(1);
    });

    it('propagates non-NOSCRIPT errors', async () => {
      const broken = {
        evalsha: async () => {
          throw new Error('READONLY You cannot write against a read only replica.');
        },
        eval: async () => [1, 0, 0, 0],
      };
      const limiter = new RedisFixedWindowLimiter(broken, 5, 10_000);
      await expect(limiter.check('x')).rejects.toThrow('READONLY');
    });
  });

  describe('RedisFixedWindowLimiter', () => {
    it('enforces the limit and emits header values', async () => {
      const limiter = new RedisFixedWindowLimiter(redis, 3, 10_000);
      const first = await limiter.check('c');
      expect(first.allowed).toBe(true);
      expect(first.limit).toBe(3);
      expect(first.remaining).toBe(2);

      await limiter.check('c');
      await limiter.check('c');
      const denied = await limiter.check('c');
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(10);
    });

    it('rolls over when the (server-side) window advances', async () => {
      const limiter = new RedisFixedWindowLimiter(redis, 1, 10_000);
      expect((await limiter.check('c')).allowed).toBe(true);
      expect((await limiter.check('c')).allowed).toBe(false);
      redis.advance(10_000);
      expect((await limiter.check('c')).allowed).toBe(true);
    });

    it('isolates keys', async () => {
      const limiter = new RedisFixedWindowLimiter(redis, 1, 10_000);
      expect((await limiter.check('a')).allowed).toBe(true);
      expect((await limiter.check('a')).allowed).toBe(false);
      expect((await limiter.check('b')).allowed).toBe(true);
    });
  });

  describe('RedisTokenBucketLimiter', () => {
    it('bursts to capacity then refills fractionally on server time', async () => {
      const limiter = new RedisTokenBucketLimiter(redis, 2, 1);
      expect((await limiter.check('c')).allowed).toBe(true);
      expect((await limiter.check('c')).allowed).toBe(true);
      const denied = await limiter.check('c');
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterSeconds).toBe(1);

      redis.advance(500); // half a token
      expect((await limiter.check('c')).allowed).toBe(false);
      redis.advance(500); // fraction accumulates to a full token
      expect((await limiter.check('c')).allowed).toBe(true);
    });
  });

  describe('RedisSlidingWindowLogLimiter', () => {
    it('prunes expired entries and slides the window', async () => {
      const limiter = new RedisSlidingWindowLogLimiter(redis, 2, 10_000);
      expect((await limiter.check('c')).allowed).toBe(true); // t=0
      redis.advance(4_000);
      expect((await limiter.check('c')).allowed).toBe(true); // t=4s
      redis.advance(4_000);
      expect((await limiter.check('c')).allowed).toBe(false); // t=8s, both live

      redis.advance(2_001); // t=10.001s: the t=0 entry slid out
      expect((await limiter.check('c')).allowed).toBe(true);
    });

    it('reset tracks the oldest live entry', async () => {
      const limiter = new RedisSlidingWindowLogLimiter(redis, 2, 10_000);
      const start = redis.nowMs;
      await limiter.check('c');
      redis.advance(3_000);
      const second = await limiter.check('c');
      expect(second.resetSeconds).toBe(Math.ceil((start + 10_000) / 1000));
    });
  });
});

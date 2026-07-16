import type { RateLimiter, RateLimitParams } from '../types';
import { FixedWindowMemoryLimiter } from './memory/fixedWindow';
import { TokenBucketMemoryLimiter } from './memory/tokenBucket';
import { SlidingWindowLogMemoryLimiter } from './memory/slidingWindowLog';
import { RedisFixedWindowLimiter } from './redis/fixedWindow';
import { RedisTokenBucketLimiter } from './redis/tokenBucket';
import { RedisSlidingWindowLogLimiter } from './redis/slidingWindowLog';
import type { RedisScriptRunner } from './redis/runScript';

export type StoreContext =
  | { kind: 'memory'; now?: () => number }
  | { kind: 'redis'; client: RedisScriptRunner };

/**
 * Build a limiter for the given algorithm parameters against the selected
 * store. Store selection is driven by the environment: REDIS_URL set -> Redis
 * (shared, atomic), otherwise per-process memory.
 */
export function createLimiter(params: RateLimitParams, store: StoreContext): RateLimiter {
  if (store.kind === 'memory') {
    switch (params.algorithm) {
      case 'fixed-window':
        return new FixedWindowMemoryLimiter(params.limit, params.windowSeconds * 1000, store.now);
      case 'sliding-window-log':
        return new SlidingWindowLogMemoryLimiter(params.limit, params.windowSeconds * 1000, store.now);
      case 'token-bucket':
        return new TokenBucketMemoryLimiter(params.capacity, params.refillPerSecond, store.now);
    }
  }
  switch (params.algorithm) {
    case 'fixed-window':
      return new RedisFixedWindowLimiter(store.client, params.limit, params.windowSeconds * 1000);
    case 'sliding-window-log':
      return new RedisSlidingWindowLogLimiter(store.client, params.limit, params.windowSeconds * 1000);
    case 'token-bucket':
      return new RedisTokenBucketLimiter(store.client, params.capacity, params.refillPerSecond);
  }
}

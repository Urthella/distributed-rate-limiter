import type { RateLimitDecision, RateLimiter } from '../../types';
import { SLIDING_WINDOW_SCRIPT } from './scripts';
import { runScript, type RedisScriptRunner } from './runScript';

let memberCounter = 0;

/**
 * Sliding Window Log backed by a Redis sorted set. Prune + count + insert run
 * in one atomic Lua script; entries are scored with the Redis server clock.
 * Member names get a per-process unique suffix so concurrent requests from
 * multiple gateway replicas in the same millisecond never collide.
 */
export class RedisSlidingWindowLogLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisScriptRunner,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly keyPrefix = 'rl:sw',
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const member = `${process.pid}-${memberCounter++}`;
    const raw = await runScript(
      this.client,
      SLIDING_WINDOW_SCRIPT,
      [`${this.keyPrefix}:${key}`],
      [this.limit, this.windowMs, member],
    );
    const [allowed, remaining, resetMs, nowMs] = raw as number[];
    const ok = allowed === 1;
    return {
      allowed: ok,
      limit: this.limit,
      remaining,
      resetSeconds: Math.ceil(resetMs / 1000),
      retryAfterSeconds: ok ? undefined : Math.max(1, Math.ceil((resetMs - nowMs) / 1000)),
    };
  }
}

import type { RateLimitDecision, RateLimiter } from '../../types';
import { TOKEN_BUCKET_SCRIPT } from './scripts';
import { runScript, type RedisScriptRunner } from './runScript';

/**
 * Token Bucket backed by Redis. Refill (fractional) and consume happen in one
 * atomic Lua script using the Redis server clock, so any number of gateway
 * replicas share exactly one bucket per client.
 */
export class RedisTokenBucketLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisScriptRunner,
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly keyPrefix = 'rl:tb',
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const raw = await runScript(
      this.client,
      TOKEN_BUCKET_SCRIPT,
      [`${this.keyPrefix}:${key}`],
      [this.capacity, this.refillPerSecond],
    );
    const [allowed, remaining, resetMs, retryMs] = raw as number[];
    const ok = allowed === 1;
    return {
      allowed: ok,
      limit: this.capacity,
      remaining,
      resetSeconds: Math.ceil(resetMs / 1000),
      retryAfterSeconds: ok ? undefined : Math.max(1, Math.ceil(retryMs / 1000)),
    };
  }
}

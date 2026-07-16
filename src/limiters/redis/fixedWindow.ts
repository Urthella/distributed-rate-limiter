import type { RateLimitDecision, RateLimiter } from '../../types';
import { FIXED_WINDOW_SCRIPT } from './scripts';
import { runScript, type RedisScriptRunner } from './runScript';

/**
 * Fixed Window Counter backed by Redis. One atomic Lua round-trip per check;
 * all timestamps come from the Redis server clock (TIME).
 */
export class RedisFixedWindowLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisScriptRunner,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly keyPrefix = 'rl:fw',
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const raw = await runScript(
      this.client,
      FIXED_WINDOW_SCRIPT,
      [`${this.keyPrefix}:${key}`],
      [this.limit, this.windowMs],
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

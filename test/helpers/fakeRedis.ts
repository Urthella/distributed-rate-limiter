import { createHash } from 'node:crypto';
import {
  FIXED_WINDOW_SCRIPT,
  SLIDING_WINDOW_SCRIPT,
  TOKEN_BUCKET_SCRIPT,
} from '../../src/limiters/redis/scripts';
import type { RedisScriptRunner } from '../../src/limiters/redis/runScript';

/**
 * Lightweight in-process fake of the Redis EVAL/EVALSHA surface.
 *
 * It faithfully models the *protocol*: EVALSHA fails with NOSCRIPT until the
 * script has been loaded via EVAL (exactly like a real server), which lets the
 * tests exercise the fallback path in runScript(). Each of the three bundled
 * Lua scripts is mirrored with the same state model and arithmetic
 * (fixed-window counters, float token buckets, sorted-set logs) driven by a
 * controllable clock, so the surrounding limiter classes are tested against
 * realistic results. Parity with a real server is additionally covered by
 * test/redisIntegration.test.ts (skipped unless REDIS_URL is set).
 */
export class FakeRedis implements RedisScriptRunner {
  nowMs = 1_700_000_000_000;

  evalshaCalls = 0;
  evalCalls = 0;

  private scriptsBySha = new Map<string, string>();
  private counters = new Map<string, number>();
  private buckets = new Map<string, { tokens: number; ts: number }>();
  private zsets = new Map<string, { member: string; score: number }[]>();

  advance(ms: number): void {
    this.nowMs += ms;
  }

  async evalsha(sha: string, _numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown> {
    this.evalshaCalls++;
    const script = this.scriptsBySha.get(sha);
    if (!script) {
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    }
    return this.run(script, keysAndArgs);
  }

  async eval(script: string, _numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown> {
    this.evalCalls++;
    const sha = createHash('sha1').update(script).digest('hex');
    this.scriptsBySha.set(sha, script);
    return this.run(script, keysAndArgs);
  }

  private run(script: string, keysAndArgs: (string | number)[]): number[] {
    const key = String(keysAndArgs[0]);
    const args = keysAndArgs.slice(1);
    if (script === FIXED_WINDOW_SCRIPT) {
      return this.fixedWindow(key, Number(args[0]), Number(args[1]));
    }
    if (script === TOKEN_BUCKET_SCRIPT) {
      return this.tokenBucket(key, Number(args[0]), Number(args[1]));
    }
    if (script === SLIDING_WINDOW_SCRIPT) {
      return this.slidingWindow(key, Number(args[0]), Number(args[1]), String(args[2]));
    }
    throw new Error(`FakeRedis: unknown script:\n${script}`);
  }

  // --- mirrors of the Lua scripts (same state model + arithmetic) ---

  private fixedWindow(baseKey: string, limit: number, windowMs: number): number[] {
    const windowId = Math.floor(this.nowMs / windowMs);
    const key = `${baseKey}:${windowId}`;
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    const remaining = Math.max(0, limit - count);
    const allowed = count <= limit ? 1 : 0;
    const resetMs = (windowId + 1) * windowMs;
    return [allowed, remaining, resetMs, this.nowMs];
  }

  private tokenBucket(key: string, capacity: number, refillPerSecond: number): number[] {
    let state = this.buckets.get(key);
    if (!state) state = { tokens: capacity, ts: this.nowMs };
    const elapsedMs = Math.max(0, this.nowMs - state.ts);
    let tokens = Math.min(capacity, state.tokens + (elapsedMs * refillPerSecond) / 1000);
    let allowed = 0;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = 1;
    }
    this.buckets.set(key, { tokens, ts: this.nowMs });
    const retryMs = allowed === 0 ? Math.ceil(((1 - tokens) / refillPerSecond) * 1000) : 0;
    const fullMs = Math.ceil(((capacity - tokens) / refillPerSecond) * 1000);
    return [allowed, Math.floor(tokens), this.nowMs + fullMs, retryMs, this.nowMs];
  }

  private slidingWindow(key: string, limit: number, windowMs: number, member: string): number[] {
    let entries = this.zsets.get(key) ?? [];
    entries = entries.filter((e) => e.score > this.nowMs - windowMs);
    let allowed = 0;
    if (entries.length < limit) {
      entries.push({ member: `${this.nowMs}-${member}`, score: this.nowMs });
      allowed = 1;
    }
    entries.sort((a, b) => a.score - b.score);
    this.zsets.set(key, entries);
    const remaining = Math.max(0, limit - entries.length);
    const oldest = entries[0];
    const resetMs = oldest ? oldest.score + windowMs : this.nowMs + windowMs;
    return [allowed, remaining, resetMs, this.nowMs];
  }
}

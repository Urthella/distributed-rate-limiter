import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedWindowMemoryLimiter } from '../src/limiters/memory/fixedWindow';

// 2026-01-01T00:00:00Z — divisible by the 10s window, so windows align exactly.
const T0 = 1_767_225_600_000;

describe('FixedWindowMemoryLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the limit, then denies with Retry-After', async () => {
    const limiter = new FixedWindowMemoryLimiter(3, 10_000);
    for (let i = 0; i < 3; i++) {
      expect((await limiter.check('k')).allowed).toBe(true);
    }
    const denied = await limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBe(10); // full window remains at T0
  });

  it('reports correct limit / remaining / reset header values', async () => {
    const limiter = new FixedWindowMemoryLimiter(3, 10_000);
    const first = await limiter.check('k');
    expect(first.limit).toBe(3);
    expect(first.remaining).toBe(2);
    expect(first.resetSeconds).toBe(T0 / 1000 + 10);

    const second = await limiter.check('k');
    expect(second.remaining).toBe(1);
    const third = await limiter.check('k');
    expect(third.remaining).toBe(0);
    expect(third.allowed).toBe(true);
  });

  it('rolls over to a fresh window', async () => {
    const limiter = new FixedWindowMemoryLimiter(2, 10_000);
    await limiter.check('k');
    await limiter.check('k');
    expect((await limiter.check('k')).allowed).toBe(false);

    vi.setSystemTime(T0 + 10_000); // exactly the next window
    const fresh = await limiter.check('k');
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(1);
    expect(fresh.resetSeconds).toBe(T0 / 1000 + 20);
  });

  it('shrinking retry-after as the window progresses', async () => {
    const limiter = new FixedWindowMemoryLimiter(1, 10_000);
    await limiter.check('k');
    vi.setSystemTime(T0 + 7_000);
    const denied = await limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(3);
  });

  it('isolates keys from each other', async () => {
    const limiter = new FixedWindowMemoryLimiter(1, 10_000);
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(false);
    expect((await limiter.check('b')).allowed).toBe(true); // unaffected by "a"
  });
});

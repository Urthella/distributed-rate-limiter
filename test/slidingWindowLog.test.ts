import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlidingWindowLogMemoryLimiter } from '../src/limiters/memory/slidingWindowLog';

const T0 = 1_767_225_600_000;

describe('SlidingWindowLogMemoryLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the limit inside the trailing window, then denies', async () => {
    const limiter = new SlidingWindowLogMemoryLimiter(2, 10_000);
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(true);
    const denied = await limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBe(10);
  });

  it('slides: old entries expire individually, unlike a fixed window', async () => {
    const limiter = new SlidingWindowLogMemoryLimiter(2, 10_000);
    await limiter.check('k'); // t = 0s
    vi.setSystemTime(T0 + 4_000);
    await limiter.check('k'); // t = 4s

    vi.setSystemTime(T0 + 8_000);
    expect((await limiter.check('k')).allowed).toBe(false); // both still in window

    vi.setSystemTime(T0 + 10_001); // entry at t=0 has slid out; t=4s remains
    const allowed = await limiter.check('k');
    expect(allowed.allowed).toBe(true);

    expect((await limiter.check('k')).allowed).toBe(false); // t=4s + t=10.001s fill the window
  });

  it('prunes expired entries from the log (memory does not grow)', async () => {
    const limiter = new SlidingWindowLogMemoryLimiter(3, 10_000);
    await limiter.check('k');
    await limiter.check('k');
    await limiter.check('k');
    expect(limiter.logSize('k')).toBe(3);

    vi.setSystemTime(T0 + 20_000); // everything expired
    await limiter.check('k');
    expect(limiter.logSize('k')).toBe(1); // pruned down to just the new entry
  });

  it('denied requests are not recorded (no penalty extension)', async () => {
    const limiter = new SlidingWindowLogMemoryLimiter(1, 10_000);
    await limiter.check('k');
    await limiter.check('k'); // denied
    await limiter.check('k'); // denied
    expect(limiter.logSize('k')).toBe(1);
  });

  it('reset header points at the oldest entry plus the window', async () => {
    const limiter = new SlidingWindowLogMemoryLimiter(2, 10_000);
    await limiter.check('k'); // oldest at T0
    vi.setSystemTime(T0 + 3_000);
    const second = await limiter.check('k');
    expect(second.resetSeconds).toBe(Math.ceil((T0 + 10_000) / 1000));

    const denied = await limiter.check('k');
    expect(denied.retryAfterSeconds).toBe(7); // oldest (T0) + 10s - now (T0+3s)
  });

  it('isolates keys', async () => {
    const limiter = new SlidingWindowLogMemoryLimiter(1, 10_000);
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(false);
    expect((await limiter.check('b')).allowed).toBe(true);
  });
});

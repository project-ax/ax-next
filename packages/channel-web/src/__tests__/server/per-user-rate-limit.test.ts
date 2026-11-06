// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPerUserRateLimiter } from '../../server/per-user-rate-limit.js';

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createPerUserRateLimiter', () => {
  it('allows `limit` takes per window per person, then refuses; another person is unaffected', () => {
    const c = clock();
    const l = createPerUserRateLimiter({ limit: 3, windowMs: 60_000, maxUsers: 10, now: c.now });
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, true]);
    expect(l.take('a')).toBe(false);
    expect(l.take('b')).toBe(true);
  });

  it('the window slides: a take frees up exactly windowMs after it was spent', () => {
    const c = clock();
    const l = createPerUserRateLimiter({ limit: 2, windowMs: 60_000, maxUsers: 10, now: c.now });
    expect(l.take('a')).toBe(true); // t=0
    c.advance(30_000);
    expect(l.take('a')).toBe(true); // t=30s
    expect(l.take('a')).toBe(false);
    c.advance(29_999); // t=59.999s: the first take is still inside the window
    expect(l.take('a')).toBe(false);
    c.advance(1); // t=60s: the first take has slid out, the second has not
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(false);
  });

  it('a refused take does not count, so hammering does not extend the wait', () => {
    const c = clock();
    const l = createPerUserRateLimiter({ limit: 1, windowMs: 60_000, maxUsers: 10, now: c.now });
    expect(l.take('a')).toBe(true);
    for (let i = 0; i < 50; i++) {
      c.advance(1_000);
      l.take('a');
    }
    c.advance(10_000); // 60 s after the one counted take
    expect(l.take('a')).toBe(true);
  });

  it('tracks at most maxUsers people: a new person is refused while the map is full, admitted once others expire', () => {
    const c = clock();
    const l = createPerUserRateLimiter({ limit: 5, windowMs: 60_000, maxUsers: 2, now: c.now });
    expect(l.take('a')).toBe(true);
    expect(l.take('b')).toBe(true);
    expect(l.take('c')).toBe(false);
    // Someone already tracked is never refused for the map being full.
    expect(l.take('a')).toBe(true);
    c.advance(60_000);
    expect(l.take('c')).toBe(true);
  });
});

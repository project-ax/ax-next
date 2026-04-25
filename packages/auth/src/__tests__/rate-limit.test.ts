import { describe, it, expect } from 'vitest';
import { createRateLimiter, deriveKey } from '../rate-limit.js';

// ---------------------------------------------------------------------------
// Unit tests for the rate-limit token bucket. Pure logic — no HTTP boot.
// ---------------------------------------------------------------------------

describe('rate-limit / deriveKey', () => {
  it('falls back to "local" when trustProxy is off', () => {
    expect(deriveKey({ 'x-forwarded-for': '1.2.3.4' }, false)).toBe('local');
    expect(deriveKey({}, false)).toBe('local');
  });

  it('uses x-forwarded-for first hop when trustProxy is on', () => {
    expect(deriveKey({ 'x-forwarded-for': '203.0.113.5' }, true)).toBe(
      'ip:203.0.113.5',
    );
    expect(
      deriveKey({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, true),
    ).toBe('ip:203.0.113.5');
  });

  it('falls back to "local" when trustProxy is on but XFF is absent', () => {
    expect(deriveKey({}, true)).toBe('local');
    expect(deriveKey({ 'x-forwarded-for': '' }, true)).toBe('local');
  });
});

describe('rate-limit / createRateLimiter', () => {
  it('allows up to N requests per window then rejects', () => {
    let now = 0;
    const lim = createRateLimiter({
      tokensPerWindow: 3,
      windowMs: 1000,
      matchPath: (p) => p.startsWith('/auth/'),
      now: () => now,
      trustProxy: () => false,
    });
    const headers = {};
    expect(lim.check(headers, '/auth/sign-in/google')).toBeNull();
    expect(lim.check(headers, '/auth/sign-in/google')).toBeNull();
    expect(lim.check(headers, '/auth/sign-in/google')).toBeNull();
    const reject = lim.check(headers, '/auth/sign-in/google');
    expect(reject).not.toBeNull();
    expect(reject!.reason).toBe('rate-limited');
  });

  it('refills the bucket after windowMs elapses', () => {
    let now = 1000;
    const lim = createRateLimiter({
      tokensPerWindow: 2,
      windowMs: 500,
      matchPath: () => true,
      now: () => now,
      trustProxy: () => false,
    });
    expect(lim.check({}, '/auth/x')).toBeNull();
    expect(lim.check({}, '/auth/x')).toBeNull();
    expect(lim.check({}, '/auth/x')).not.toBeNull();
    now += 500;
    expect(lim.check({}, '/auth/x')).toBeNull();
  });

  it('does not consume tokens for non-matching paths', () => {
    const lim = createRateLimiter({
      tokensPerWindow: 1,
      windowMs: 60_000,
      matchPath: (p) => p.startsWith('/auth/'),
      now: () => 0,
      trustProxy: () => false,
    });
    // 100 hits to /other shouldn't drain the bucket; the next /auth/* still passes.
    for (let i = 0; i < 100; i++) lim.check({}, '/other');
    expect(lim.check({}, '/auth/sign-in/google')).toBeNull();
  });

  it('keeps separate buckets per IP when trustProxy is on', () => {
    const lim = createRateLimiter({
      tokensPerWindow: 1,
      windowMs: 60_000,
      matchPath: () => true,
      now: () => 0,
      trustProxy: () => true,
    });
    expect(
      lim.check({ 'x-forwarded-for': '1.1.1.1' }, '/auth/x'),
    ).toBeNull();
    expect(
      lim.check({ 'x-forwarded-for': '1.1.1.1' }, '/auth/x'),
    ).not.toBeNull();
    // Different IP gets its own bucket.
    expect(
      lim.check({ 'x-forwarded-for': '2.2.2.2' }, '/auth/x'),
    ).toBeNull();
  });
});

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VIEW_TOKEN_TTL_SECONDS,
  linkBindingFor,
  signViewToken,
  verifyViewToken,
  type ViewTokenClaims,
} from '../artifacts/view-token.js';

const key = randomBytes(32);
const otherKey = randomBytes(32);
const now = 1_800_000_000;
const claims: ViewTokenClaims = {
  artifactId: 'art-1',
  version: 3,
  purpose: 'view',
  linkBinding: null,
  expiresAt: now + VIEW_TOKEN_TTL_SECONDS,
};

/** A token whose payload is `json`, signed with `key`, so only the claims check can refuse it. */
function signedRaw(json: unknown, k: Uint8Array = key): string {
  const payload = Buffer.from(JSON.stringify(json)).toString('base64url');
  const sig = createHmac('sha256', k).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${sig}`;
}

describe('view tokens', () => {
  it('round-trips, and rejects a tampered payload, a tampered signature, another key, an expired and a far-future token', () => {
    const t = signViewToken(key, claims);
    expect(verifyViewToken(key, t, now)).toEqual(claims);
    expect(t.length).toBeLessThanOrEqual(600);
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const [v, payload, sig] = t.split('.') as [string, string, string];
    const otherPayload = Buffer.from(
      JSON.stringify({ a: 'art-1', n: 4, p: 'view', l: null, e: claims.expiresAt }),
    ).toString('base64url');
    expect(verifyViewToken(key, `${v}.${otherPayload}.${sig}`, now)).toBeNull();
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyViewToken(key, `${v}.${payload}.${flipped}`, now)).toBeNull();

    expect(verifyViewToken(otherKey, t, now)).toBeNull();
    expect(verifyViewToken(key, t, claims.expiresAt)).toBeNull();
    expect(verifyViewToken(key, t, claims.expiresAt - 1)).toEqual(claims);
    expect(verifyViewToken(key, signViewToken(key, { ...claims, expiresAt: now + 400 }), now)).toBeNull();
    expect(verifyViewToken(key, signViewToken(key, { ...claims, expiresAt: now + 360 }), now)).not.toBeNull();
  });

  it('carries the purpose and the link binding', () => {
    const bound: ViewTokenClaims = { ...claims, purpose: 'download', linkBinding: linkBindingFor('A'.repeat(32)) };
    expect(verifyViewToken(key, signViewToken(key, bound), now)).toEqual(bound);
  });

  it('linkBindingFor is the first 22 characters of base64url(sha256(code))', () => {
    const code = 'abcdefghijklmnopqrstuvwxyz012345';
    const want = createHash('sha256').update(code).digest('base64url').slice(0, 22);
    expect(linkBindingFor(code)).toBe(want);
    expect(linkBindingFor(code)).toHaveLength(22);
    expect(linkBindingFor(`${code.slice(0, -1)}6`)).not.toBe(want);
  });

  it('rejects malformed and oversized tokens without throwing', () => {
    const good = signViewToken(key, claims);
    const [, payload, sig] = good.split('.') as [string, string, string];
    const bad: unknown[] = [
      '',
      'v1',
      'v1.',
      'v1..',
      `v2.${payload}.${sig}`,
      `${good}.extra`,
      `v1.${payload}`,
      `v1.${payload}.${sig}=`,
      `v1.${payload}.${sig.slice(0, -2)}`,
      `v1.${payload}!.${sig}`,
      'v1.%%%.%%%',
      `v1.${'A'.repeat(700)}.${sig}`,
      'x'.repeat(10_000),
      // Signed, but the claims are not ours.
      signedRaw('not an object'),
      signedRaw(null),
      signedRaw({ a: 'art-1', n: 3, p: 'view', l: null }),
      signedRaw({ a: 'art-1', n: 3, p: 'edit', l: null, e: claims.expiresAt }),
      signedRaw({ a: 'art-1', n: 0, p: 'view', l: null, e: claims.expiresAt }),
      signedRaw({ a: 'art-1', n: 1.5, p: 'view', l: null, e: claims.expiresAt }),
      signedRaw({ a: '', n: 3, p: 'view', l: null, e: claims.expiresAt }),
      signedRaw({ a: 'art-1', n: 3, p: 'view', l: 'short', e: claims.expiresAt }),
      signedRaw({ a: 'art-1', n: 3, p: 'view', l: null, e: claims.expiresAt, extra: 1 }),
      signedRaw({ a: 'art-1', n: 3, p: 'view', l: null, e: String(claims.expiresAt) }),
    ];
    // Non-JSON payload, correctly signed.
    const junk = Buffer.from('{not json').toString('base64url');
    bad.push(`v1.${junk}.${createHmac('sha256', key).update(`v1.${junk}`).digest('base64url')}`);
    for (const t of bad) {
      expect(() => verifyViewToken(key, t as string, now)).not.toThrow();
      expect(verifyViewToken(key, t as string, now)).toBeNull();
    }
    for (const t of [undefined, null, 42, {}]) {
      expect(verifyViewToken(key, t as unknown as string, now)).toBeNull();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '@ax/test-harness';
import {
  ALLOWED_JWS_ALGS,
  CLOCK_TOLERANCE_SECONDS,
  assertJwksUrl,
  createCallerVerifier,
  createViewerVerifier,
} from '../verify-token.js';

// The clock seam: every verifier below reads this instant, in epoch ms.
const T = 1_800_000_000_000;
const NOW_S = T / 1000;
const now = (): number => T;

const AUD = 'https://ax.test/api/apps-bridge/v1';
const SUB = 'platform-service-account@example.test';
const VIEWER_AUD = '/projects/123/apps/platform';

const open: FakeOidcIssuer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((i) => i.close()));
});

async function issuerFor(alg: 'RS256' | 'ES256' = 'RS256'): Promise<FakeOidcIssuer> {
  const issuer = await startFakeOidcIssuer({ alg });
  open.push(issuer);
  return issuer;
}

function callerFor(issuer: FakeOidcIssuer) {
  return createCallerVerifier(
    { issuer: issuer.issuer, jwksUrl: issuer.jwksUrl, audience: AUD, subject: SUB },
    { now },
  );
}

function viewerFor(issuer: FakeOidcIssuer, maxAgeSeconds = 600) {
  return createViewerVerifier(
    { issuer: issuer.issuer, jwksUrl: issuer.jwksUrl, audience: VIEWER_AUD, maxAgeSeconds },
    { now },
  );
}

function callerClaims(issuer: FakeOidcIssuer, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: issuer.issuer, aud: AUD, sub: SUB, iat: NOW_S - 10, exp: NOW_S + 300, ...over };
}

function viewerClaims(issuer: FakeOidcIssuer, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: issuer.issuer,
    aud: VIEWER_AUD,
    sub: 'accounts.example:1234',
    email: 'viewer@example.test',
    iat: NOW_S - 5,
    exp: NOW_S + 600,
    ...over,
  };
}

function without(claims: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...claims };
  delete copy[key];
  return copy;
}

describe('constants', () => {
  it('allows only asymmetric algorithms and a 30 s tolerance', () => {
    expect([...ALLOWED_JWS_ALGS]).toEqual([
      'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA',
    ]);
    expect(CLOCK_TOLERANCE_SECONDS).toBe(30);
  });
});

describe('caller verifier', () => {
  it('caller: accepts the configured issuer, audience and subject', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    expect(await verify(issuer.mint(callerClaims(issuer)))).toEqual({ ok: true });
    // An audience array that contains ours is accepted too (jose's aud rule).
    expect(await verify(issuer.mint(callerClaims(issuer, { aud: ['other', AUD] })))).toEqual({ ok: true });
  });

  it('caller: accepts RS256 and ES256 issuers alike', async () => {
    for (const alg of ['RS256', 'ES256'] as const) {
      const issuer = await issuerFor(alg);
      expect(await callerFor(issuer)(issuer.mint(callerClaims(issuer)))).toEqual({ ok: true });
    }
  });

  it('caller: each mismatched claim has its own reason', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    expect(await verify(issuer.mint(callerClaims(issuer, { iss: 'https://evil.test' }))))
      .toEqual({ ok: false, reason: 'wrong-issuer' });
    expect(await verify(issuer.mint(without(callerClaims(issuer), 'iss'))))
      .toEqual({ ok: false, reason: 'wrong-issuer' });
    expect(await verify(issuer.mint(callerClaims(issuer, { aud: 'https://other.test' }))))
      .toEqual({ ok: false, reason: 'wrong-audience' });
    expect(await verify(issuer.mint(without(callerClaims(issuer), 'aud'))))
      .toEqual({ ok: false, reason: 'wrong-audience' });
    expect(await verify(issuer.mint(callerClaims(issuer, { sub: 'someone-else@example.test' }))))
      .toEqual({ ok: false, reason: 'wrong-subject' });
    expect(await verify(issuer.mint(without(callerClaims(issuer), 'sub'))))
      .toEqual({ ok: false, reason: 'wrong-subject' });
  });

  it('caller: exp is checked with 30 s tolerance', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    expect(await verify(issuer.mint(callerClaims(issuer, { iat: NOW_S - 600, exp: NOW_S - 29 }))))
      .toEqual({ ok: true });
    expect(await verify(issuer.mint(callerClaims(issuer, { iat: NOW_S - 600, exp: NOW_S - 31 }))))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('caller: a token without exp is refused', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    expect(await verify(issuer.mint(without(callerClaims(issuer), 'exp'))))
      .toEqual({ ok: false, reason: 'bad-claims' });
    expect(await verify(issuer.mint(callerClaims(issuer, { exp: String(NOW_S + 300) }))))
      .toEqual({ ok: false, reason: 'bad-claims' });
  });

  it('caller: nbf in the future beyond tolerance is refused', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    expect(await verify(issuer.mint(callerClaims(issuer, { nbf: NOW_S + 29 })))).toEqual({ ok: true });
    expect(await verify(issuer.mint(callerClaims(issuer, { nbf: NOW_S + 31 }))))
      .toEqual({ ok: false, reason: 'not-yet-valid' });
  });
});

describe('forged and foreign tokens', () => {
  it('alg none and an HS256 token signed with the public key are refused', async () => {
    const issuer = await issuerFor();
    const caller = callerFor(issuer);
    const viewer = viewerFor(issuer);
    const none = issuer.mint(callerClaims(issuer), { alg: 'none' });
    const hs = issuer.mint(callerClaims(issuer), { alg: 'HS256' });
    const vNone = issuer.mint(viewerClaims(issuer), { alg: 'none' });
    const vHs = issuer.mint(viewerClaims(issuer), { alg: 'HS256' });

    // alg none carries an empty signature: refused by shape, before any key lookup.
    expect(await caller(none)).toEqual({ ok: false, reason: 'malformed' });
    expect(await viewer(vNone)).toEqual({ ok: false, reason: 'malformed' });
    // A none token with a non-empty junk signature still never passes.
    expect(await caller(`${none}c2ln`)).toEqual({ ok: false, reason: 'bad-signature' });
    // HS256 is outside the allow-list: refused before the key set is consulted.
    expect(await caller(hs)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await viewer(vHs)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(issuer.jwksRequests()).toBe(0);
  });

  it('a token from another key or an unknown kid is refused', async () => {
    const issuer = await issuerFor();
    const impostor = await issuerFor();
    const verify = callerFor(issuer);
    // Signed by a different key that claims our kid.
    expect(await verify(impostor.mint(callerClaims(issuer), { kid: issuer.kid })))
      .toEqual({ ok: false, reason: 'bad-signature' });
    // Signed by a different key under its own kid: no matching key.
    expect(await verify(impostor.mint(callerClaims(issuer))))
      .toEqual({ ok: false, reason: 'bad-signature' });
    // Our key, unknown kid.
    expect(await verify(issuer.mint(callerClaims(issuer), { kid: 'unknown-kid' })))
      .toEqual({ ok: false, reason: 'bad-signature' });
    // An ES256 token against an RS256-only key set: no key of that type.
    const es = await issuerFor('ES256');
    expect(await verify(es.mint(callerClaims(issuer), { kid: issuer.kid })))
      .toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('a tampered payload is a bad signature', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    const [h, , s] = issuer.mint(callerClaims(issuer, { sub: 'someone-else' })).split('.');
    const forgedPayload = Buffer.from(JSON.stringify(callerClaims(issuer))).toString('base64url');
    expect(await verify(`${h}.${forgedPayload}.${s}`)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('an overlong token is malformed and never fetches keys', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    const viewer = viewerFor(issuer);
    const good = issuer.mint(callerClaims(issuer));
    const overlong = good + 'A'.repeat(8193 - good.length);
    expect(overlong).toHaveLength(8193);
    expect(await verify(overlong)).toEqual({ ok: false, reason: 'malformed' });
    expect(await viewer(overlong)).toEqual({ ok: false, reason: 'malformed' });
    expect(issuer.jwksRequests()).toBe(0);
  });

  it('a token that is not three base64url parts is malformed and never fetches keys', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    const good = issuer.mint(callerClaims(issuer));
    const [h, p, s] = good.split('.');
    for (const bad of [
      '', 'abc', `${h}.${p}`, `${good}.x`, `${h}..${s}`, `${h}.${p}.${s}=`, `${h}.${p}.${s} `,
      `${h}.${p}+.${s}`, `Bearer ${good}`,
    ]) {
      expect(await verify(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(await verify(undefined as unknown as string)).toEqual({ ok: false, reason: 'malformed' });
    expect(issuer.jwksRequests()).toBe(0);
  });

  it('a well-shaped token with a garbage header or payload is malformed', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    const [h, p, s] = issuer.mint(callerClaims(issuer)).split('.');
    expect(await verify(`AAAA.${p}.${s}`)).toEqual({ ok: false, reason: 'malformed' });
    // A signed payload that is JSON but not an object.
    const notObject = issuer.mint([1, 2, 3] as unknown as Record<string, unknown>);
    expect(await verify(notObject)).toEqual({ ok: false, reason: 'malformed' });
    expect(h).toBeTruthy();
  });

  it('a JWKS outage is keys-unavailable, not a bad token', async () => {
    const issuer = await issuerFor();
    issuer.setJwksStatus(500);
    const verify = callerFor(issuer);
    expect(await verify(issuer.mint(callerClaims(issuer)))).toEqual({ ok: false, reason: 'keys-unavailable' });
    expect(issuer.jwksRequests()).toBe(1);

    const closed = await issuerFor();
    const unreachable = callerFor(closed);
    const token = closed.mint(callerClaims(closed));
    await closed.close();
    expect(await unreachable(token)).toEqual({ ok: false, reason: 'keys-unavailable' });
  });

  it('caches keys: two verifications fetch the JWKS once', async () => {
    const issuer = await issuerFor();
    const verify = callerFor(issuer);
    expect(await verify(issuer.mint(callerClaims(issuer)))).toEqual({ ok: true });
    expect(await verify(issuer.mint(callerClaims(issuer)))).toEqual({ ok: true });
    expect(issuer.jwksRequests()).toBe(1);
  });
});

describe('viewer verifier', () => {
  it('viewer: returns the email of a fresh assertion (ES256, as IAP signs)', async () => {
    const issuer = await issuerFor('ES256');
    const verify = viewerFor(issuer);
    expect(await verify(issuer.mint(viewerClaims(issuer)))).toEqual({ ok: true, email: 'viewer@example.test' });
    expect(await verify(issuer.mint(viewerClaims(issuer, { aud: 'elsewhere' }))))
      .toEqual({ ok: false, reason: 'wrong-audience' });
    expect(await verify(issuer.mint(viewerClaims(issuer, { iss: 'https://evil.test' }))))
      .toEqual({ ok: false, reason: 'wrong-issuer' });
  });

  it('viewer: max age is iat plus tolerance', async () => {
    const issuer = await issuerFor('ES256');
    const verify = viewerFor(issuer, 600);
    expect(await verify(issuer.mint(viewerClaims(issuer, { iat: NOW_S - 629 }))))
      .toEqual({ ok: true, email: 'viewer@example.test' });
    expect(await verify(issuer.mint(viewerClaims(issuer, { iat: NOW_S - 631 }))))
      .toEqual({ ok: false, reason: 'too-old' });
  });

  it('viewer: iat and exp are required; exp past tolerance is expired', async () => {
    const issuer = await issuerFor('ES256');
    const verify = viewerFor(issuer);
    expect(await verify(issuer.mint(without(viewerClaims(issuer), 'iat'))))
      .toEqual({ ok: false, reason: 'bad-claims' });
    expect(await verify(issuer.mint(without(viewerClaims(issuer), 'exp'))))
      .toEqual({ ok: false, reason: 'bad-claims' });
    expect(await verify(issuer.mint(viewerClaims(issuer, { exp: NOW_S - 31 }))))
      .toEqual({ ok: false, reason: 'expired' });
    // iat in the future beyond tolerance.
    expect(await verify(issuer.mint(viewerClaims(issuer, { iat: NOW_S + 31 }))))
      .toEqual({ ok: false, reason: 'bad-claims' });
  });

  it('viewer: a missing, non-string or overlong email is bad-claims', async () => {
    const issuer = await issuerFor('ES256');
    const verify = viewerFor(issuer);
    const local = 'a'.repeat(64);
    const at320 = `${local}@${'b'.repeat(320 - 65)}`;
    expect(at320).toHaveLength(320);
    expect(await verify(issuer.mint(viewerClaims(issuer, { email: at320 })))).toEqual({ ok: true, email: at320 });
    expect(await verify(issuer.mint(viewerClaims(issuer, { email: 'a@b' })))).toEqual({ ok: true, email: 'a@b' });

    const badEmails: unknown[] = [
      undefined, // removed below
      42,
      null,
      ['viewer@example.test'],
      { email: 'viewer@example.test' },
      '',
      '@b',
      'a@',
      `${at320}c`,
      'no-at-sign.example.test',
      'two@@example.test',
      'a@b@c.test',
      'sp ace@example.test',
      'tab\u0009@example.test',
      'nul\u0000@example.test',
      'caf\u00e9@example.test',
      'rtl\u202e@example.test',
      'del\u007f@example.test',
    ];
    expect(await verify(issuer.mint(without(viewerClaims(issuer), 'email'))))
      .toEqual({ ok: false, reason: 'bad-claims' });
    for (const email of badEmails.slice(1)) {
      expect(await verify(issuer.mint(viewerClaims(issuer, { email })))).toEqual({ ok: false, reason: 'bad-claims' });
    }
  });

  it('viewer: email_verified false is bad-claims; absent is fine', async () => {
    const issuer = await issuerFor('ES256');
    const verify = viewerFor(issuer);
    expect(await verify(issuer.mint(viewerClaims(issuer)))).toEqual({ ok: true, email: 'viewer@example.test' });
    expect(await verify(issuer.mint(viewerClaims(issuer, { email_verified: true }))))
      .toEqual({ ok: true, email: 'viewer@example.test' });
    for (const v of [false, 'true', 1, null]) {
      expect(await verify(issuer.mint(viewerClaims(issuer, { email_verified: v }))))
        .toEqual({ ok: false, reason: 'bad-claims' });
    }
  });

  it('viewer: an RS256 issuer works too, and forged tokens never pass', async () => {
    const issuer = await issuerFor('RS256');
    const verify = viewerFor(issuer);
    expect(await verify(issuer.mint(viewerClaims(issuer)))).toEqual({ ok: true, email: 'viewer@example.test' });
    const other = await issuerFor('ES256');
    expect(await verify(other.mint(viewerClaims(issuer)))).toEqual({ ok: false, reason: 'bad-signature' });
  });
});

describe('assertJwksUrl', () => {
  it('assertJwksUrl: https or loopback http only, no credentials', () => {
    expect(assertJwksUrl('https://www.googleapis.com/oauth2/v3/certs').href)
      .toBe('https://www.googleapis.com/oauth2/v3/certs');
    expect(assertJwksUrl('http://127.0.0.1:1/jwks').href).toBe('http://127.0.0.1:1/jwks');
    expect(assertJwksUrl('http://localhost:8080/jwks').hostname).toBe('localhost');
    expect(assertJwksUrl('http://[::1]:8080/jwks').hostname).toBe('[::1]');

    for (const bad of [
      'http://example.com/jwks',
      'http://10.0.0.1/jwks',
      'http://localhost.example.com/jwks',
      'https://u:p@x.test/jwks',
      'https://u@x.test/jwks',
      'http://u:p@127.0.0.1/jwks',
      'ftp://x.test/jwks',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(() => assertJwksUrl(bad), bad).toThrow(Error);
    }
  });

  it('assertJwksUrl: the error names the rule, not the URL', () => {
    expect(() => assertJwksUrl('https://user:secret@x.test/jwks')).toThrow(/credentials/);
    try {
      assertJwksUrl('https://user:secret@x.test/jwks');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secret');
    }
    expect(() => assertJwksUrl('http://example.com/jwks')).toThrow(/https/);
  });

  it('the verifiers refuse a bad jwksUrl at construction', () => {
    expect(() => createCallerVerifier({ issuer: 'i', jwksUrl: 'http://example.com/jwks', audience: 'a', subject: 's' }))
      .toThrow(Error);
    expect(() => createViewerVerifier({ issuer: 'i', jwksUrl: 'https://u:p@x.test/', audience: 'a', maxAgeSeconds: 600 }))
      .toThrow(Error);
  });
});

describe('no token content in verdicts', () => {
  it('a refusal carries only the reason', async () => {
    const issuer = await issuerFor();
    const verdict = await callerFor(issuer)(issuer.mint(callerClaims(issuer, { sub: 'leak-me' })));
    expect(verdict).toEqual({ ok: false, reason: 'wrong-subject' });
    expect(JSON.stringify(verdict)).not.toContain('leak-me');
  });
});

describe('viewer max age is bounded at construction', () => {
  // NaN or Infinity would silently turn off jose's age check (Task 6 review).
  it('a max age that is not a whole number of seconds from 30 to 3600 is refused', () => {
    const cfg = { issuer: 'i', jwksUrl: 'https://x.test/jwks', audience: 'a' };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 29, 3601, 0, -1, 600.5]) {
      expect(() => createViewerVerifier({ ...cfg, maxAgeSeconds: bad }), String(bad)).toThrow(/maxAgeSeconds/);
    }
    for (const good of [30, 600, 3600]) {
      expect(() => createViewerVerifier({ ...cfg, maxAgeSeconds: good })).not.toThrow();
    }
  });
});

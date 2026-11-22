import { createPublicKey, verify, type webcrypto } from 'node:crypto';

type ServedJwk = webcrypto.JsonWebKey & { kid: string; alg: string; use: string };
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../index.js';

const open: FakeOidcIssuer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((i) => i.close()));
});

async function start(alg?: 'RS256' | 'ES256'): Promise<FakeOidcIssuer> {
  const issuer = await startFakeOidcIssuer(alg === undefined ? undefined : { alg });
  open.push(issuer);
  return issuer;
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function fetchKeys(issuer: FakeOidcIssuer): Promise<ServedJwk[]> {
  const res = await fetch(issuer.jwksUrl);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { keys: ServedJwk[] };
  return body.keys;
}

describe('startFakeOidcIssuer', () => {
  it('serves its public key and mints tokens a JWKS-verifying client accepts', async () => {
    for (const alg of ['RS256', 'ES256'] as const) {
      const issuer = await start(alg);
      expect(issuer.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(issuer.jwksUrl).toBe(`${issuer.issuer}/jwks`);

      const keys = await fetchKeys(issuer);
      expect(keys).toHaveLength(1);
      const jwk = keys[0]!;
      expect(jwk).toMatchObject({ kid: issuer.kid, alg, use: 'sig' });
      // Public members only: no private exponent / scalar leaks into the JWKS.
      expect(jwk.d).toBeUndefined();

      const token = issuer.mint({ iss: issuer.issuer, sub: 'caller', n: 1 });
      const [h, p, s] = token.split('.') as [string, string, string];
      expect(decodePart(h)).toEqual({ alg, typ: 'JWT', kid: issuer.kid });
      expect(decodePart(p)).toEqual({ iss: issuer.issuer, sub: 'caller', n: 1 });

      const key = createPublicKey({ key: jwk, format: 'jwk' });
      const ok = verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
        Buffer.from(s, 'base64url'),
      );
      expect(ok).toBe(true);
    }
  });

  it('defaults to RS256 and lets mint override the kid', async () => {
    const issuer = await start();
    const keys = await fetchKeys(issuer);
    expect(keys[0]!.alg).toBe('RS256');
    const token = issuer.mint({}, { kid: 'other' });
    expect(decodePart(token.split('.')[0]!)).toMatchObject({ alg: 'RS256', kid: 'other' });
  });

  it('mints forged HS256 (public key DER as secret) and alg none tokens', async () => {
    const issuer = await start('RS256');
    const hs = issuer.mint({ a: 1 }, { alg: 'HS256' });
    expect(decodePart(hs.split('.')[0]!)).toMatchObject({ alg: 'HS256' });
    expect(hs.split('.')[2]!.length).toBeGreaterThan(0);

    const none = issuer.mint({ a: 1 }, { alg: 'none' });
    const parts = none.split('.');
    expect(parts).toHaveLength(3);
    expect(decodePart(parts[0]!)).toMatchObject({ alg: 'none' });
    expect(parts[2]).toBe('');
  });

  it('counts JWKS requests and answers the configured status', async () => {
    const issuer = await start();
    expect(issuer.jwksRequests()).toBe(0);
    await fetchKeys(issuer);
    expect(issuer.jwksRequests()).toBe(1);
    issuer.setJwksStatus(500);
    const res = await fetch(issuer.jwksUrl);
    expect(res.status).toBe(500);
    await res.arrayBuffer();
    expect(issuer.jwksRequests()).toBe(2);
    const other = await fetch(`${issuer.issuer}/elsewhere`);
    expect(other.status).toBe(404);
    await other.arrayBuffer();
    expect(issuer.jwksRequests()).toBe(2);
  });
});

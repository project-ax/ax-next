import { describe, expect, it, vi } from 'vitest';
import {
  accountFromIdToken,
  fetchUserinfoAccount,
  requestScopeWithIdentity,
  sanitizeAccount,
} from '../identity.js';

// Slice 4 — "Signed in as". Provider-reported identity is UNTRUSTED text used
// for display only, so every path here is fail-soft (null, never a throw).

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const jwt = (payload: unknown) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(payload))}.sig`;

describe('sanitizeAccount', () => {
  it('non-string → null', () => {
    for (const v of [undefined, null, 42, true, {}, ['a@b.c']]) expect(sanitizeAccount(v)).toBeNull();
  });

  it('empty / whitespace-only / control-only → null', () => {
    expect(sanitizeAccount('')).toBeNull();
    expect(sanitizeAccount('   ')).toBeNull();
    expect(sanitizeAccount('\u0000\u001f\u007f\u0085')).toBeNull();
  });

  it('strips C0/C1 control characters (Cc) and trims', () => {
    expect(sanitizeAccount('  al\nice\r@ex\tample.com\u0000\u009b ')).toBe('alice@example.com');
  });

  it('strips the bidi controls U+200E, U+200F, U+202A–U+202E, U+2066–U+2069', () => {
    const bidi = '‎‏‪‫‬‭‮⁦⁧⁨⁩';
    expect(sanitizeAccount(`a${bidi}b@example.com`)).toBe('ab@example.com');
    // A right-to-left override that would visually reverse the tail is gone.
    expect(sanitizeAccount('evil‮moc.elgoog@x')).toBe('evilmoc.elgoog@x');
  });

  it('keeps ordinary non-ASCII text', () => {
    expect(sanitizeAccount('zoë@exämple.com')).toBe('zoë@exämple.com');
  });

  it('caps at 254 code points', () => {
    const out = sanitizeAccount('a'.repeat(2000))!;
    expect([...out]).toHaveLength(254);
  });

  it('never splits a surrogate pair at the 254 boundary', () => {
    const emoji = '\u{1F600}'; // two UTF-16 units, one code point
    const out = sanitizeAccount('a'.repeat(253) + emoji + 'tail')!;
    expect([...out]).toHaveLength(254);
    expect(out.endsWith(emoji)).toBe(true);
    // No lone surrogate anywhere.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });
});

describe('accountFromIdToken', () => {
  it('email present → email (preferred over preferred_username and sub)', () => {
    expect(accountFromIdToken(jwt({ email: 'alice@example.com', preferred_username: 'al', sub: '123' })))
      .toBe('alice@example.com');
  });

  it('only preferred_username → preferred_username', () => {
    expect(accountFromIdToken(jwt({ preferred_username: 'alice', sub: '123' }))).toBe('alice');
  });

  it('only sub → sub', () => {
    expect(accountFromIdToken(jwt({ sub: 'user-123' }))).toBe('user-123');
  });

  it('no usable claim → null', () => {
    expect(accountFromIdToken(jwt({ name: 'Alice' }))).toBeNull();
  });

  it.each([
    ['not a string', 42],
    ['undefined', undefined],
    ['two parts', `${b64url('{}')}.${b64url('{"email":"a@b.c"}')}`],
    ['four parts', `${b64url('{}')}.${b64url('{"email":"a@b.c"}')}.sig.extra`],
    ['bad base64url payload', `${b64url('{}')}.!!!not*base64$$.sig`],
    ['non-JSON payload', `${b64url('{}')}.${b64url('not json')}.sig`],
    ['payload is a JSON array', `${b64url('{}')}.${b64url('["a@b.c"]')}.sig`],
    ['payload is a JSON string', `${b64url('{}')}.${b64url('"a@b.c"')}.sig`],
    ['payload is null', `${b64url('{}')}.${b64url('null')}.sig`],
    ['empty payload', `${b64url('{}')}..sig`],
  ])('malformed (%s) → null, never throws', (_label, token) => {
    expect(() => accountFromIdToken(token)).not.toThrow();
    expect(accountFromIdToken(token)).toBeNull();
  });

  it('email a number → falls through to the next claim', () => {
    expect(accountFromIdToken(jwt({ email: 12345, preferred_username: 'alice' }))).toBe('alice');
    expect(accountFromIdToken(jwt({ email: 12345 }))).toBeNull();
  });

  it('a hostile email (2,000 chars, RLO, newlines, <script>) is stripped and capped — kept as literal text', () => {
    const hostile = `‮<script>alert(1)</script>\n\r${'x'.repeat(2000)}@evil.example`;
    const out = accountFromIdToken(jwt({ email: hostile }))!;
    expect(out).not.toBeNull();
    expect([...out]).toHaveLength(254);
    expect(out).not.toMatch(/[‮\n\r]/);
    // Not HTML-escaped here: rendering as a text node is the UI's job.
    expect(out.startsWith('<script>alert(1)</script>')).toBe(true);
  });
});

describe('fetchUserinfoAccount', () => {
  const endpoint = 'https://auth.example.com/userinfo';
  const allowedHosts = new Set(['auth.example.com']);
  const resolver = async () => '93.184.216.34';
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

  it('happy path → the email claim; one GET, bearer token, redirect manual', async () => {
    const fetchImpl = vi.fn(async () => json({ email: 'alice@example.com', sub: '1' }));
    const out = await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver });
    expect(out).toBe('alice@example.com');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer AT');
  });

  it('falls through preferred_username → sub like the id_token', async () => {
    const fetchImpl = vi.fn(async () => json({ sub: 'user-9' }));
    expect(await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver })).toBe('user-9');
  });

  it('302 → null, and NO second request (the bearer token never follows a redirect)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example.net/steal' },
    }));
    const out = await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver });
    expect(out).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('non-2xx (401, 500) → null', async () => {
    for (const status of [401, 500]) {
      const fetchImpl = vi.fn(async () => json({ email: 'alice@example.com' }, { status }));
      expect(await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver })).toBeNull();
    }
  });

  it('a host off the allowlist → null, with no request at all', async () => {
    const fetchImpl = vi.fn(async () => json({ email: 'alice@example.com' }));
    const out = await fetchUserinfoAccount({
      endpoint: 'https://evil.example.net/userinfo', accessToken: 'AT', allowedHosts, fetchImpl, resolver,
    });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an allowlisted host that resolves to a private IP → null, with no request', async () => {
    const fetchImpl = vi.fn(async () => json({ email: 'alice@example.com' }));
    const out = await fetchUserinfoAccount({
      endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver: async () => '169.254.169.254',
    });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('http: → null, with no request', async () => {
    const fetchImpl = vi.fn(async () => json({ email: 'alice@example.com' }));
    const out = await fetchUserinfoAccount({
      endpoint: 'http://auth.example.com/userinfo', accessToken: 'AT', allowedHosts, fetchImpl, resolver,
    });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a timeout (endpoint hangs, ignoring the abort signal) → null', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const out = await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver, timeoutMs: 30 });
    expect(out).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a timeout aborts the request via its signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_u: string | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    });
    const out = await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver, timeoutMs: 30 });
    expect(out).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('a timeout during the host check → null, and the token is never sent afterwards', async () => {
    const fetchImpl = vi.fn(async () => json({ email: 'alice@example.com' }));
    const slowResolver = () => new Promise<string>((r) => setTimeout(() => r('93.184.216.34'), 80));
    const out = await fetchUserinfoAccount({
      endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver: slowResolver, timeoutMs: 20,
    });
    expect(out).toBeNull();
    await new Promise((r) => setTimeout(r, 120)); // let the slow check finish
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a body that never finishes (headers arrive, body hangs) → null after the timeout', async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    const out = await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver, timeoutMs: 30 });
    expect(out).toBeNull();
  });

  it('an oversized body (10 MB) → null', async () => {
    const big = JSON.stringify({ email: 'alice@example.com', pad: 'x'.repeat(10 * 1024 * 1024) });
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }));
    expect(await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver })).toBeNull();
  });

  it('a body just over maxBytes → null; at maxBytes → parsed', async () => {
    const body = JSON.stringify({ email: 'alice@example.com' });
    const len = Buffer.byteLength(body);
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    expect(await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver, maxBytes: len - 1 })).toBeNull();
    expect(await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver, maxBytes: len })).toBe('alice@example.com');
  });

  it('non-JSON, a JSON array, or a fetch that throws → null', async () => {
    for (const make of [
      async () => new Response('<html>nope</html>', { status: 200 }),
      async () => json(['alice@example.com']),
      async () => { throw new Error('ECONNRESET'); },
    ]) {
      const fetchImpl = vi.fn(make);
      expect(await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver })).toBeNull();
    }
  });

  it('a hostile email is sanitized', async () => {
    const fetchImpl = vi.fn(async () => json({ email: '‮alice\n@example.com' }));
    expect(await fetchUserinfoAccount({ endpoint, accessToken: 'AT', allowedHosts, fetchImpl, resolver })).toBe('alice@example.com');
  });
});

describe('requestScopeWithIdentity', () => {
  const md = (scopes_supported?: unknown) => ({ ...(scopes_supported !== undefined ? { scopes_supported } : {}) });

  it('adds openid and email when the AS supports both', () => {
    expect(requestScopeWithIdentity('read write', md(['openid', 'email', 'read']))).toBe('read write openid email');
  });

  it('adds only openid when the AS supports openid but not email', () => {
    expect(requestScopeWithIdentity('read', md(['openid', 'read']))).toBe('read openid');
  });

  it('adds nothing when the AS supports email without openid (email is an OIDC scope)', () => {
    expect(requestScopeWithIdentity('read', md(['email', 'read']))).toBe('read');
  });

  it('never duplicates a scope already present', () => {
    expect(requestScopeWithIdentity('openid read email', md(['openid', 'email']))).toBe('openid read email');
    expect(requestScopeWithIdentity('read read', md(['openid']))).toBe('read openid');
  });

  it('unchanged when scopes_supported is absent or not a string array', () => {
    expect(requestScopeWithIdentity('read', md())).toBe('read');
    expect(requestScopeWithIdentity('read', md('openid email'))).toBe('read');
    expect(requestScopeWithIdentity('read', md([1, 2]))).toBe('read');
  });

  it('no base scope → stays undefined (asking for only openid email would narrow the AS default grant)', () => {
    expect(requestScopeWithIdentity(undefined, md(['openid', 'email']))).toBeUndefined();
    expect(requestScopeWithIdentity('', md(['openid', 'email']))).toBe('');
  });
});

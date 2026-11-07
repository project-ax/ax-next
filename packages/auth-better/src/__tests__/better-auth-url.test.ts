import { describe, expect, it } from 'vitest';
import { betterAuthUrl } from '../better-auth-url.js';

// ---------------------------------------------------------------------------
// TASK-1052: the URL handed to Better Auth. With no pinned `baseURL`, Better
// Auth takes its base URL, its trusted origin and the OAuth `redirect_uri`
// from this URL's origin, so no request header may choose the scheme, and the
// Host may not move the path, the query or the userinfo Better Auth routes on.
// ---------------------------------------------------------------------------

const base = { path: '/auth/get-session', query: { a: '1' } };

function urlFor(host: string | undefined): { url: string; malformedHost: boolean } {
  return betterAuthUrl({
    ...base,
    protocol: 'http',
    headers: host === undefined ? {} : { host },
  });
}

// Legitimate shapes that must never be refused: a port, an IPv6 literal,
// uppercase, an underscore (compose-style service names) and punycode.
const ACCEPTED = [
  'ax.example.com',
  'ax.example.com:8443',
  '127.0.0.1:8080',
  '[::1]',
  '[::1]:3000',
  'localhost',
  'my_service:80',
  'AX.Example.COM',
  'xn--9ca.com',
];

// Both measured failure shapes: values that made `new Request` throw (a 500)
// and values that silently moved the path or query Better Auth routes on.
const REFUSED = [
  'a b',
  'evil.example/x',
  'x?y',
  'x#y',
  'u@x',
  'x\\y',
  'x:99999',
  '999.1.1.1',
  '[::1',
  'x:',
  'x:8080:9',
  'x<y',
  'x%41',
  'é.com',
];

describe('betterAuthUrl (TASK-1052)', () => {
  it('takes the scheme from req.protocol, never from X-Forwarded-Proto', () => {
    expect(
      betterAuthUrl({
        ...base,
        protocol: 'http',
        headers: { host: 'ax.example.com', 'x-forwarded-proto': 'https' },
      }),
    ).toEqual({ url: 'http://ax.example.com/auth/get-session?a=1', malformedHost: false });
    const { url } = betterAuthUrl({
      ...base,
      protocol: 'https',
      headers: { host: 'ax.example.com', 'x-forwarded-proto': 'http' },
    });
    expect(url.startsWith('https://ax.example.com/'), url).toBe(true);
  });

  it.each(ACCEPTED)('accepts the Host %j', (host) => {
    const { url, malformedHost } = urlFor(host);
    expect(malformedHost).toBe(false);
    expect(new URL(url).host).toBe(new URL(`http://${host}`).host);
  });

  it.each([undefined, ''])('an absent or empty Host (%j) means localhost, not malformed', (host) => {
    expect(urlFor(host)).toEqual({
      url: 'http://localhost/auth/get-session?a=1',
      malformedHost: false,
    });
  });

  it.each(REFUSED)('refuses the Host %j: localhost, flagged malformed', (host) => {
    expect(urlFor(host)).toEqual({
      url: 'http://localhost/auth/get-session?a=1',
      malformedHost: true,
    });
  });

  it('no Host value can move the path, the query or the userinfo', () => {
    for (const host of [...ACCEPTED, ...REFUSED, '']) {
      const url = new URL(urlFor(host).url);
      expect(url.pathname, host).toBe('/auth/get-session');
      expect(url.search, host).toBe('?a=1');
      expect(url.username, host).toBe('');
    }
  });
});

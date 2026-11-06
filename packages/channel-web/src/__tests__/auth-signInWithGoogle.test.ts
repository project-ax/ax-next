/**
 * `signInWithGoogle()` wire contract.
 *
 * Regression guard for the PR #112 migration leftover: when `@ax/auth-oidc`
 * was replaced by `@ax/auth-better` (better-auth), the backend social
 * sign-in surface changed shape but this client wasn't migrated. The old
 * `@ax/auth-oidc` plugin hand-rolled `GET /auth/sign-in/google` and
 * 302-redirected; better-auth has no such route — it exposes
 * `POST /auth/sign-in/social` with `{ provider }` in the body and returns
 * `{ url }` for the client to navigate to. Driving the browser to
 * `GET /auth/sign-in/google` therefore 404s.
 *
 * Pinned behaviors:
 *   - POSTs to `/auth/sign-in/social` (NOT a GET to `/auth/sign-in/google`)
 *   - body carries `{ provider: 'google', callbackURL: '/' }`, or the share
 *     page's own path when sign-in starts on `/a/<code>` (and only then)
 *   - sends credentials + the `X-Requested-With: ax-admin` CSRF header
 *   - navigates to the `url` better-auth returns
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signInWithGoogle } from '../lib/auth';

const CODE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123_-';

const fetchMock = vi.fn();
let originalLocation: Location;
let originalFetch: typeof fetch;

beforeEach(() => {
  fetchMock.mockReset();
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  originalLocation = window.location;
  // jsdom's location.href isn't freely writable; swap in a plain object so
  // the assignment in signInWithGoogle() is observable.
  Object.defineProperty(window, 'location', {
    writable: true,
    // `pathname` still reads the real location, so `history.replaceState`
    // moves it the way a real page would.
    value: {
      href: '',
      get pathname() {
        return originalLocation.pathname;
      },
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
  window.history.replaceState(null, '', '/');
});

function socialOk(url: string): Response {
  return new Response(JSON.stringify({ url, redirect: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('signInWithGoogle() — better-auth social wire contract', () => {
  it('POSTs /auth/sign-in/social with the google provider body', async () => {
    fetchMock.mockResolvedValueOnce(socialOk('https://accounts.google.com/o/oauth2/auth?x=1'));

    await signInWithGoogle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/auth/sign-in/social');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Requested-With']).toBe('ax-admin');
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'google',
      callbackURL: '/',
    });
  });

  it('navigates to the url better-auth returns', async () => {
    fetchMock.mockResolvedValueOnce(socialOk('https://accounts.google.com/o/oauth2/auth?x=2'));

    await signInWithGoogle();

    expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/auth?x=2');
  });
});

describe('signInWithGoogle(callbackPath) — where sign-in comes back to', () => {
  function sentCallback(): unknown {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return (JSON.parse(init.body as string) as { callbackURL: unknown }).callbackURL;
  }

  it('Google sign-in from a share link comes back to it', async () => {
    fetchMock.mockResolvedValueOnce(socialOk('https://accounts.google.com/o/oauth2/auth?x=3'));
    window.history.replaceState(null, '', `/a/${CODE}`);
    await signInWithGoogle(window.location.pathname);
    expect(sentCallback()).toBe(`/a/${CODE}`);
  });

  it.each([
    '/',
    '/settings',
    '/a/' + 'A'.repeat(31),
    `/a/${CODE}/`,
    `/a/${CODE}/x`,
    '//evil.example',
    `//evil.example/a/${CODE}`,
    `https://evil.example/a/${CODE}`,
    `/a/${CODE}?next=https://evil.example`,
    '/a/%2e%2e',
    'javascript:alert(1)',
  ])('anywhere else, and for a forged path, the callback stays "/" (%s)', async (p) => {
    fetchMock.mockResolvedValueOnce(socialOk('https://accounts.google.com/o/oauth2/auth?x=4'));
    await signInWithGoogle(p);
    expect(sentCallback()).toBe('/');
  });
});

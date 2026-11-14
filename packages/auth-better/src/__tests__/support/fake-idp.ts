import { vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';

// ---------------------------------------------------------------------------
// TASK-1116. A stand-in for Google and GitHub, so a test can drive a REAL
// better-auth OAuth callback: `POST /auth/sign-in/social`, then
// `GET /auth/callback/<provider>` with the state cookie, through the whole ax
// stack (http-server, the ax_auth_session bridge, Postgres).
//
// It answers the provider endpoints better-auth calls from the server, through
// a `fetch` spy (better-fetch reads `globalThis.fetch` per call):
//   - Google's token endpoint returns an UNSIGNED id_token. Google's callback
//     only decodes it (`getUserInfo`), so the claims in it are what better-auth
//     believes. Only the client-posted ID-token path verifies a signature, so
//     `signGoogleIdToken` signs with a key the fake JWKS endpoint serves.
//   - GitHub's token, `/user` and `/user/emails` endpoints.
// Any other https: URL throws, so a test never leaves the machine. Plain http
// (the tests' own calls to 127.0.0.1) goes to the real fetch.
// ---------------------------------------------------------------------------

export const GOOGLE_CLIENT_ID = 'test-google-client';
export const GITHUB_CLIENT_ID = 'test-github-client';

const GOOGLE_KEY_ID = 'fake-google-key';

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  sub: string;
}

export interface GithubIdentity {
  id: number;
  login: string;
  email: string;
  verified: boolean;
}

export interface FakeIdp {
  /** What Google's token exchange returns from now on (sticky until the next call). */
  nextGoogle(identity: GoogleIdentity): void;
  /** What GitHub's `/user` and `/user/emails` return from now on (sticky). */
  nextGithub(identity: GithubIdentity): void;
  /** RS256, audience GOOGLE_CLIENT_ID, signed by the key the fake JWKS serves. */
  signGoogleIdToken(identity: GoogleIdentity): Promise<string>;
  restore(): void;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function googleClaims(identity: GoogleIdentity): Record<string, unknown> {
  return {
    email: identity.email,
    email_verified: identity.emailVerified,
    sub: identity.sub,
    name: 'Test',
  };
}

export async function installFakeIdp(): Promise<FakeIdp> {
  const realFetch = globalThis.fetch;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: GOOGLE_KEY_ID, alg: 'RS256', use: 'sig' };
  let google: GoogleIdentity | undefined;
  let github: GithubIdentity | undefined;

  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        if (google === undefined) throw new Error('fake-idp: nextGoogle() was not called');
        const idToken = new UnsecuredJWT(googleClaims(google))
          .setIssuer('https://accounts.google.com')
          .setAudience(GOOGLE_CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .encode();
        return Response.json({
          access_token: 'fake-google-access',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
          id_token: idToken,
        });
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
        return Response.json({ keys: [jwk] });
      }
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        return Response.json({
          access_token: 'fake-github-access',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        });
      }
      // Before `/user`: it shares the prefix.
      if (url.startsWith('https://api.github.com/user/emails')) {
        if (github === undefined) throw new Error('fake-idp: nextGithub() was not called');
        return Response.json([
          { email: github.email, primary: true, verified: github.verified, visibility: null },
        ]);
      }
      if (url.startsWith('https://api.github.com/user')) {
        if (github === undefined) throw new Error('fake-idp: nextGithub() was not called');
        return Response.json({
          id: github.id,
          login: github.login,
          name: github.login,
          email: null,
          avatar_url: null,
        });
      }
      if (url.startsWith('https:')) {
        throw new Error(`fake-idp: unexpected outbound fetch to ${new URL(url).origin}`);
      }
      return realFetch(input, init);
    });

  return {
    nextGoogle: (identity) => {
      google = identity;
    },
    nextGithub: (identity) => {
      github = identity;
    },
    signGoogleIdToken: (identity) =>
      new SignJWT(googleClaims(identity))
        .setProtectedHeader({ alg: 'RS256', kid: GOOGLE_KEY_ID })
        .setIssuer('https://accounts.google.com')
        .setAudience(GOOGLE_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey),
    restore: () => {
      spy.mockRestore();
    },
  };
}

let clientIpCounter = 0;

/**
 * A new valid IPv4 (198.18.0.0/15, the benchmarking range) on every call.
 *
 * better-auth limits `/sign-in*` to 3 per 10 s per IP and path, keys that on a
 * single-IP `X-Forwarded-For`, and shares its limiter store across the file.
 * A fresh address per request keeps every test out of every other's bucket.
 */
export function freshClientIp(): string {
  clientIpCounter += 1;
  const n = clientIpCounter;
  return `198.${18 + ((n >> 16) & 1)}.${(n >> 8) & 255}.${n & 255}`;
}

export interface OAuthResult {
  status: number;
  /** The Location header, `''` when there is none. */
  location: string;
  /** Every Set-Cookie on the callback's response, joined. */
  setCookie: string;
  /** The `ax_auth_session=<value>` pair the callback set, or null. */
  axSession: string | null;
}

/**
 * One whole redirect-flow sign-in, as the login page starts it: ask for the
 * provider's authorize URL, then come back to the callback with its `state`
 * and the state cookie, as the provider would send the browser back.
 *
 * Throws on a harness failure (the start isn't a 200, or no state); a refusal
 * comes back as a redirect to `/auth/error?error=<code>`.
 */
export async function oauthSignIn(
  baseUrl: string,
  provider: 'google' | 'github',
): Promise<OAuthResult> {
  const start = await fetch(`${baseUrl}/auth/sign-in/social`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
      'x-forwarded-for': freshClientIp(),
    },
    body: JSON.stringify({ provider, callbackURL: '/' }),
  });
  const startBody = await start.text();
  if (start.status !== 200) {
    throw new Error(`fake-idp: sign-in/social answered ${start.status}: ${startBody}`);
  }
  const authorizeUrl = (JSON.parse(startBody) as { url?: unknown }).url;
  const state =
    typeof authorizeUrl === 'string' ? new URL(authorizeUrl).searchParams.get('state') : null;
  // ax joins every Set-Cookie into one header (plugin.ts), so search the lot.
  const statePair = /ax_better_auth\.state=[^;,\s]+/.exec(start.headers.getSetCookie().join('\n'))?.[0];
  if (state === null || statePair === undefined) {
    throw new Error(`fake-idp: no state (url ${String(authorizeUrl)}, cookie ${String(statePair)})`);
  }

  const callback = await fetch(
    `${baseUrl}/auth/callback/${provider}?code=fake-code&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { cookie: statePair, 'x-forwarded-for': freshClientIp() } },
  );
  const setCookie = callback.headers.getSetCookie().join('\n');
  await callback.arrayBuffer();
  return {
    status: callback.status,
    location: callback.headers.get('location') ?? '',
    setCookie,
    axSession: /ax_auth_session=[^;,\s]+/.exec(setCookie)?.[0] ?? null,
  };
}

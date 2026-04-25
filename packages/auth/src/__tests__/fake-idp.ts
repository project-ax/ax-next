import * as http from 'node:http';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';

// ---------------------------------------------------------------------------
// Tiny in-process fake IdP for OIDC tests.
//
// Implements the minimum surface our code calls:
//   GET  /.well-known/openid-configuration   discovery
//   GET  /authorize                          auto-redirects with code+state
//   POST /token                              code → tokens (id_token + at)
//   GET  /userinfo                           bearer-protected claims
//   GET  /jwks                               JWKS for id_token verification
//
// One key pair per instance, generated lazily on .start(). The fake IdP
// signs id_tokens with that key; openid-client verifies via /jwks.
//
// Lives under __tests__/ so it's not part of the production bundle.
// ---------------------------------------------------------------------------

export interface FakeIdpOptions {
  clientId: string;
  /** Subject id baked into the id_token + userinfo. */
  subject: string;
  email?: string | null;
  name?: string | null;
  /**
   * If set, the /authorize handler returns this string as `code` regardless
   * of the request. Defaults to a fresh random per-call code.
   */
  fixedCode?: string;
}

export interface StartedFakeIdp {
  baseUrl: string;
  port: number;
  /** Stop the listener and free the port. */
  close(): Promise<void>;
  /**
   * Last-seen `code_challenge` from /authorize. Tests assert PKCE was sent.
   */
  lastChallenge(): { code_challenge: string; code_challenge_method: string } | null;
  /** Number of /token requests served. */
  tokenCalls(): number;
  /** Whether /token saw the code_verifier matching the most recent challenge. */
  pkceVerifiedOk(): boolean;
}

interface PendingCode {
  state: string;
  nonce: string;
  challenge: string;
  challengeMethod: string;
}

export async function startFakeIdp(opts: FakeIdpOptions): Promise<StartedFakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwk.kid = 'fake-idp-key-1';

  const codes = new Map<string, PendingCode>();
  let lastChallenge: PendingCode | null = null;
  let pkceOk = false;
  let tokenHits = 0;
  // Hold a reference to the running server so we can close it cleanly.
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Defensive — fake IdP must not blow up the test runner.
      // eslint-disable-next-line no-console
      console.error('[fake-idp] handler error', err);
      try {
        res.statusCode = 500;
        res.end('internal');
      } catch {}
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', baseUrl);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          userinfo_endpoint: `${baseUrl}/userinfo`,
          jwks_uri: `${baseUrl}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }

    if (method === 'GET' && path === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    if (method === 'GET' && path === '/authorize') {
      const state = url.searchParams.get('state') ?? '';
      const nonce = url.searchParams.get('nonce') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const challengeMethod = url.searchParams.get('code_challenge_method') ?? '';
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const code = opts.fixedCode ?? `code_${Math.random().toString(36).slice(2, 12)}`;
      const pending: PendingCode = { state, nonce, challenge, challengeMethod };
      codes.set(code, pending);
      lastChallenge = pending;
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }

    if (method === 'POST' && path === '/token') {
      tokenHits += 1;
      const body = await readForm(req);
      const code = body.get('code') ?? '';
      const verifier = body.get('code_verifier') ?? '';
      const pending = codes.get(code);
      if (pending === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      // Verify PKCE: SHA-256(verifier) base64url == challenge.
      const expected = base64UrlSha256(verifier);
      pkceOk = expected === pending.challenge;
      if (!pkceOk) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'pkce mismatch' }));
        return;
      }
      // Code is single-use — consume.
      codes.delete(code);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: pending.nonce,
        email: opts.email ?? null,
        name: opts.name ?? null,
      })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid! })
        .setIssuer(baseUrl)
        .setSubject(opts.subject)
        .setAudience(opts.clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(privateKey);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'fake-access-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 600,
        }),
      );
      return;
    }

    if (method === 'GET' && path === '/userinfo') {
      const auth = req.headers.authorization ?? '';
      if (!/^Bearer fake-access-token$/.test(auth)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          sub: opts.subject,
          email: opts.email ?? null,
          name: opts.name ?? null,
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found', path }));
  }

  return {
    baseUrl,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    lastChallenge() {
      if (lastChallenge === null) return null;
      return {
        code_challenge: lastChallenge.challenge,
        code_challenge_method: lastChallenge.challengeMethod,
      };
    },
    tokenCalls() {
      return tokenHits;
    },
    pkceVerifiedOk() {
      return pkceOk;
    },
  };
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function base64UrlSha256(input: string): string {
  // Lazy import to keep the fake IdP self-contained — tests already pull
  // node:crypto via vitest's global. Use createHash directly so we don't
  // depend on jose's internal helpers.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

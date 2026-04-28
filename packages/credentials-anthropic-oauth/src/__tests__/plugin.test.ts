import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookBus, bootstrap, makeAgentContext } from '@ax/core';
import { createCredentialsAnthropicOauthPlugin } from '../plugin.js';
import {
  ANTHROPIC_AUTHORIZE_ENDPOINT,
  ANTHROPIC_OAUTH_REDIRECT_URI,
  ANTHROPIC_TOKEN_ENDPOINT,
} from '../constants.js';

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function bootBus(): Promise<HookBus> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createCredentialsAnthropicOauthPlugin()],
    config: {},
  });
  return bus;
}

describe('@ax/credentials-anthropic-oauth plugin', () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    vi.restoreAllMocks();
  });

  it('plugin loads and registers all three services', async () => {
    const bus = await bootBus();
    expect(bus.hasService('credentials:resolve:anthropic-oauth')).toBe(true);
    expect(bus.hasService('credentials:login:anthropic-oauth')).toBe(true);
    expect(bus.hasService('credentials:exchange:anthropic-oauth')).toBe(true);
  });

  // ── login ────────────────────────────────────────────────────────────

  it('credentials:login:anthropic-oauth returns an authorize URL with PKCE challenge + state', async () => {
    const bus = await bootBus();
    const out = await bus.call<
      { redirectUri?: string },
      { authorizeUrl: string; codeVerifier: string; state: string }
    >('credentials:login:anthropic-oauth', ctx(), {});
    const u = new URL(out.authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe(ANTHROPIC_AUTHORIZE_ENDPOINT);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toBe(out.state);
    expect(u.searchParams.get('redirect_uri')).toBe(ANTHROPIC_OAUTH_REDIRECT_URI);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBeTruthy();
    // codeVerifier matches RFC 7636 charset (43+ chars from unreserved).
    expect(out.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('login: caller can override redirectUri (for tests / localhost variants)', async () => {
    const bus = await bootBus();
    const out = await bus.call<
      { redirectUri?: string },
      { authorizeUrl: string; codeVerifier: string; state: string }
    >('credentials:login:anthropic-oauth', ctx(), {
      redirectUri: 'http://127.0.0.1:9999/cb',
    });
    expect(new URL(out.authorizeUrl).searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:9999/cb',
    );
  });

  it('two login calls produce different verifiers + states (no replay)', async () => {
    const bus = await bootBus();
    const a = await bus.call<unknown, { codeVerifier: string; state: string }>(
      'credentials:login:anthropic-oauth',
      ctx(),
      {},
    );
    const b = await bus.call<unknown, { codeVerifier: string; state: string }>(
      'credentials:login:anthropic-oauth',
      ctx(),
      {},
    );
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state).not.toBe(b.state);
  });

  // ── exchange ─────────────────────────────────────────────────────────

  it('credentials:exchange:anthropic-oauth POSTs to token endpoint and returns blob', async () => {
    const bus = await bootBus();
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(ANTHROPIC_TOKEN_ENDPOINT);
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.grant_type).toBe('authorization_code');
      expect(body.code).toBe('auth-code-xyz');
      expect(body.code_verifier).toBe('verifier-abc');
      expect(body.state).toBe('state-123');
      return new Response(
        JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const out = await bus.call<
      { code: string; codeVerifier: string; state: string },
      { payload: Uint8Array; expiresAt: number; kind: string }
    >('credentials:exchange:anthropic-oauth', ctx(), {
      code: 'auth-code-xyz',
      codeVerifier: 'verifier-abc',
      state: 'state-123',
    });
    expect(out.kind).toBe('anthropic-oauth');
    const blob = JSON.parse(new TextDecoder().decode(out.payload)) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
    expect(blob.accessToken).toBe('A');
    expect(blob.refreshToken).toBe('R');
    expect(blob.expiresAt).toBe(out.expiresAt);
    // expiresAt is now+3600s (give or take a few ms).
    const drift = Math.abs(blob.expiresAt - (Date.now() + 3600 * 1000));
    expect(drift).toBeLessThan(2000);
  });

  it('exchange: rejects with PluginError(oauth-exchange-failed) on non-2xx', async () => {
    const bus = await bootBus();
    globalThis.fetch = (async () =>
      new Response('invalid_grant', { status: 400 })) as unknown as typeof globalThis.fetch;
    await expect(
      bus.call('credentials:exchange:anthropic-oauth', ctx(), {
        code: 'bad', codeVerifier: 'v', state: 's',
      }),
    ).rejects.toMatchObject({ code: 'oauth-exchange-failed' });
  });

  it('exchange: rejects when required input fields are missing', async () => {
    const bus = await bootBus();
    await expect(
      bus.call('credentials:exchange:anthropic-oauth', ctx(), {
        code: '', codeVerifier: 'v', state: 's',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(
      bus.call('credentials:exchange:anthropic-oauth', ctx(), {
        code: 'c', codeVerifier: '', state: 's',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(
      bus.call('credentials:exchange:anthropic-oauth', ctx(), {
        code: 'c', codeVerifier: 'v', state: '',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  // ── resolve ──────────────────────────────────────────────────────────

  it('resolve: returns cached access token when expiresAt is more than 5min away (I8)', async () => {
    const bus = await bootBus();
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('should-not-fire', { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    const blob = bytes(
      JSON.stringify({
        accessToken: 'tok-A',
        refreshToken: 'r-A',
        expiresAt: Date.now() + 600_000, // 10min away
      }),
    );
    const out = await bus.call<
      { payload: Uint8Array; userId: string; ref: string },
      { value: string; refreshed?: unknown }
    >('credentials:resolve:anthropic-oauth', ctx(), {
      payload: blob,
      userId: 'u1',
      ref: 'r1',
    });
    expect(out.value).toBe('tok-A');
    expect(out.refreshed).toBeUndefined();
    expect(fetched).toBe(0);
  });

  it('resolve: refreshes when expiresAt is within 5min, returns new token + refreshed blob (I8)', async () => {
    const bus = await bootBus();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: 'tok-NEW', refresh_token: 'r-NEW', expires_in: 3600 }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    const blob = bytes(
      JSON.stringify({
        accessToken: 'tok-OLD',
        refreshToken: 'r-OLD',
        expiresAt: Date.now() + 60_000, // 1min — inside the buffer
      }),
    );
    const out = await bus.call<
      { payload: Uint8Array; userId: string; ref: string },
      {
        value: string;
        refreshed?: { payload: Uint8Array; expiresAt: number };
      }
    >('credentials:resolve:anthropic-oauth', ctx(), {
      payload: blob,
      userId: 'u1',
      ref: 'r1',
    });
    expect(out.value).toBe('tok-NEW');
    expect(out.refreshed).toBeDefined();
    const refreshed = JSON.parse(new TextDecoder().decode(out.refreshed!.payload)) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
    expect(refreshed.accessToken).toBe('tok-NEW');
    expect(refreshed.refreshToken).toBe('r-NEW');
  });

  it('resolve: keeps the old refresh_token if response omits it (some OAuth servers do this)', async () => {
    const bus = await bootBus();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'tok-NEW', expires_in: 3600 }), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    const blob = bytes(
      JSON.stringify({
        accessToken: 'tok-OLD',
        refreshToken: 'r-OLD',
        expiresAt: Date.now() + 60_000,
      }),
    );
    const out = await bus.call<
      { payload: Uint8Array; userId: string; ref: string },
      {
        value: string;
        refreshed?: { payload: Uint8Array; expiresAt: number };
      }
    >('credentials:resolve:anthropic-oauth', ctx(), {
      payload: blob,
      userId: 'u1',
      ref: 'r1',
    });
    const refreshed = JSON.parse(new TextDecoder().decode(out.refreshed!.payload)) as {
      refreshToken: string;
    };
    expect(refreshed.refreshToken).toBe('r-OLD');
  });

  it('resolve: throws PluginError(oauth-refresh-failed) when token endpoint returns non-2xx (I9)', async () => {
    const bus = await bootBus();
    globalThis.fetch = (async () =>
      new Response('invalid_grant', { status: 400 })) as unknown as typeof globalThis.fetch;
    const blob = bytes(
      JSON.stringify({
        accessToken: 'tok-OLD',
        refreshToken: 'r-OLD',
        expiresAt: Date.now() + 60_000,
      }),
    );
    await expect(
      bus.call('credentials:resolve:anthropic-oauth', ctx(), {
        payload: blob,
        userId: 'u1',
        ref: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'oauth-refresh-failed' });
  });

  it('resolve: rejects malformed blob with invalid-oauth-blob', async () => {
    const bus = await bootBus();
    await expect(
      bus.call('credentials:resolve:anthropic-oauth', ctx(), {
        payload: bytes('not json'),
        userId: 'u1',
        ref: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'invalid-oauth-blob' });
    await expect(
      bus.call('credentials:resolve:anthropic-oauth', ctx(), {
        payload: bytes(JSON.stringify({ accessToken: 'a' })), // missing fields
        userId: 'u1',
        ref: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'invalid-oauth-blob' });
  });
});

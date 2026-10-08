import {
  InvalidClientError,
  InvalidGrantError,
  ServerError,
  TemporarilyUnavailableError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpOAuthResolver, NeedsReconnectError } from '../resolver.js';
import { encodeTokenBlob, decodeTokenBlob } from '../types.js';

const baseBlob = {
  accessToken: 'old', refreshToken: 'rt1', tokenType: 'Bearer', expiresAt: 0,
  scope: 'read', resource: 'https://mcp.example.com',
  authServerUrl: 'https://auth.example.com', tokenEndpoint: 'https://auth.example.com/token',
  clientKey: 'c|https://auth.example.com',
};
const deps = (over = {}) => ({
  store: { getClient: async () => ({ clientKey: 'c|a', clientId: 'cid', clientSecret: 's', dynamic: true }) },
  refresh: async () => ({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600, token_type: 'Bearer' }),
  now: () => 10_000,
  ...over,
});

describe('mcp-oauth resolver', () => {
  it('returns the stored token without refresh when still valid', async () => {
    const resolve = createMcpOAuthResolver(deps());
    const blob = encodeTokenBlob({ ...baseBlob, expiresAt: 10_000 + 10 * 60_000 });
    const out = await resolve({ payload: blob, userId: 'u', ref: 'account:c' });
    expect(out.value).toBe('old');
    expect(out.refreshed).toBeUndefined();
  });

  it('refreshes an expired token and re-stores the rotated refresh token', async () => {
    const resolve = createMcpOAuthResolver(deps());
    const out = await resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' });
    expect(out.value).toBe('new');
    expect(out.refreshed).toBeDefined();
    expect(decodeTokenBlob(out.refreshed!.payload).refreshToken).toBe('rt2');
  });

  it('preserves the old refresh token when the provider does not rotate it', async () => {
    const resolve = createMcpOAuthResolver(deps({
      refresh: async () => ({ access_token: 'new2', expires_in: 3600, token_type: 'Bearer' }), // no refresh_token
    }));
    const out = await resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' });
    expect(decodeTokenBlob(out.refreshed!.payload).refreshToken).toBe('rt1');
  });

  it('rethrows a transient refresh error (keeps the stored token) — NOT NeedsReconnect', async () => {
    const resolve = createMcpOAuthResolver(deps({ refresh: async () => { throw new Error('ETIMEDOUT'); } }));
    await expect(resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' }))
      .rejects.not.toBeInstanceOf(NeedsReconnectError);
  });

  it('NeedsReconnect when there is no refresh token to use', async () => {
    const resolve = createMcpOAuthResolver(deps());
    const { refreshToken: _rt, ...noRt } = baseBlob;
    await expect(resolve({ payload: encodeTokenBlob(noRt), userId: 'u', ref: 'account:c' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
  });
});

// ---------------------------------------------------------------------------
// TASK-696: a token refreshes as the client that ISSUED it.
// ---------------------------------------------------------------------------
describe('mcp-oauth resolver — per-token client (TASK-696)', () => {
  const ISSUED = { clientId: 'issuing-cid', clientSecret: 'issuing-secret' };

  it('refreshes with the BLOB\'s own client and never consults the shared client row', async () => {
    const getClient = vi.fn(async () => {
      throw new Error('store.getClient must not be called when the blob carries its client');
    });
    const refresh = vi.fn(async () => ({ access_token: 'new', expires_in: 3600 }));
    const resolve = createMcpOAuthResolver(deps({ store: { getClient }, refresh }));

    const out = await resolve({
      payload: encodeTokenBlob({ ...baseBlob, ...ISSUED }),
      userId: 'u',
      ref: 'account:c',
    });

    expect(out.value).toBe('new');
    expect(getClient).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    const args = refresh.mock.calls[0]![0] as unknown as {
      client: { clientId: string; clientSecret: string | undefined };
    };
    expect(args.client.clientId).toBe('issuing-cid');
    expect(args.client.clientSecret).toBe('issuing-secret');
  });

  it('a public client (blob has clientId but no clientSecret) refreshes with clientSecret undefined', async () => {
    const getClient = vi.fn(async () => {
      throw new Error('must not be called');
    });
    const refresh = vi.fn(async () => ({ access_token: 'new', expires_in: 3600 }));
    const resolve = createMcpOAuthResolver(deps({ store: { getClient }, refresh }));

    await resolve({
      payload: encodeTokenBlob({ ...baseBlob, clientId: 'public-cid' }),
      userId: 'u',
      ref: 'account:c',
    });

    const args = refresh.mock.calls[0]![0] as unknown as {
      client: { clientId: string; clientSecret: string | undefined };
    };
    expect(args.client.clientId).toBe('public-cid');
    expect(args.client.clientSecret).toBeUndefined();
    expect(getClient).not.toHaveBeenCalled();
  });

  it('LEGACY blob (no clientId) still resolves its client through store.getClient(clientKey)', async () => {
    const getClient = vi.fn(async (_k: string) => ({
      clientKey: 'c|https://auth.example.com',
      clientId: 'legacy-row-cid',
      clientSecret: 'legacy-row-secret' as string | undefined,
      dynamic: true,
    }));
    const refresh = vi.fn(async () => ({ access_token: 'new', expires_in: 3600 }));
    const resolve = createMcpOAuthResolver(deps({ store: { getClient }, refresh }));

    await resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' });

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(getClient).toHaveBeenCalledWith('c|https://auth.example.com');
    const args = refresh.mock.calls[0]![0] as unknown as { client: { clientId: string } };
    expect(args.client.clientId).toBe('legacy-row-cid');
  });

  it('LEGACY blob whose shared client row is gone → NeedsReconnectError (unchanged)', async () => {
    const resolve = createMcpOAuthResolver(deps({ store: { getClient: async () => null } }));
    await expect(resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
  });

  it('the refreshed payload KEEPS clientId/clientSecret (they survive a refresh)', async () => {
    const resolve = createMcpOAuthResolver(deps());
    const out = await resolve({
      payload: encodeTokenBlob({ ...baseBlob, ...ISSUED }),
      userId: 'u',
      ref: 'account:c',
    });
    const next = decodeTokenBlob(out.refreshed!.payload);
    expect(next.clientId).toBe('issuing-cid');
    expect(next.clientSecret).toBe('issuing-secret');
    expect(next.refreshToken).toBe('rt2');
  });

  // Slice 4 — the sign-in identity lives in the vault's ENVELOPE metadata. The
  // vault re-stores a refresh with `out.refreshed.metadata ?? env.metadata`, so
  // the resolver must not return a `metadata` of its own (even `{}` or
  // `undefined`-as-a-key would be a reason to doubt it): no key at all.
  it('the refreshed output carries NO metadata key, so the vault keeps the envelope\'s "signed in as"', async () => {
    const resolve = createMcpOAuthResolver(deps());
    const out = await resolve({
      payload: encodeTokenBlob({ ...baseBlob, ...ISSUED }),
      userId: 'u',
      ref: 'account:c',
    });
    expect(out.refreshed).toBeDefined();
    expect(Object.keys(out.refreshed!)).not.toContain('metadata');
  });
});

// ---------------------------------------------------------------------------
// TASK-696: a dead refresh is recognised by its TYPE, not by message text.
// ---------------------------------------------------------------------------
describe('mcp-oauth resolver — dead-refresh classification (TASK-696)', () => {
  const run = (refresh: () => Promise<never>) =>
    createMcpOAuthResolver(deps({ refresh }))({
      payload: encodeTokenBlob(baseBlob),
      userId: 'u',
      ref: 'account:c',
    });

  it('the SDK\'s typed InvalidGrantError → NeedsReconnectError, even when its message never says "invalid_grant"', async () => {
    // The SDK builds the message from the server's error_description, so a real
    // strict-AS rejection reads like this: no "invalid_grant" anywhere in it.
    const err = new InvalidGrantError('The provided authorization grant is invalid, expired, or revoked');
    expect(err.message).not.toContain('invalid_grant');
    await expect(run(async () => { throw err; })).rejects.toBeInstanceOf(NeedsReconnectError);
  });

  it.each([
    ['InvalidClientError', () => new InvalidClientError('Client authentication failed.')],
    ['UnauthorizedClientError', () => new UnauthorizedClientError('Client may not use this grant.')],
  ])(
    '%s (the issuing client was deleted / expired / re-keyed at the AS) → NeedsReconnectError: no retry can revive it',
    async (_name, make) => {
      await expect(run(async () => { throw make(); })).rejects.toBeInstanceOf(NeedsReconnectError);
    },
  );

  it('recognises the error structurally (errorCode), not via instanceof — a second SDK copy still counts', async () => {
    const foreign = Object.assign(new Error('nope'), { errorCode: 'invalid_grant' });
    await expect(run(async () => { throw foreign; })).rejects.toBeInstanceOf(NeedsReconnectError);
  });

  it('recognises the error by name (InvalidGrantError) when there is no errorCode getter', async () => {
    const foreign = Object.assign(new Error('nope'), { name: 'InvalidGrantError' });
    await expect(run(async () => { throw foreign; })).rejects.toBeInstanceOf(NeedsReconnectError);
  });

  it('a plain Error whose MESSAGE says invalid_grant is TRANSIENT now (rethrown as-is, not NeedsReconnect)', async () => {
    const err = new Error('invalid_grant');
    const caught = await run(async () => { throw err; }).catch((e: unknown) => e);
    expect(caught).toBe(err);
    expect(caught).not.toBeInstanceOf(NeedsReconnectError);
  });

  it.each([
    ['ServerError', () => new ServerError('upstream exploded')],
    ['TemporarilyUnavailableError', () => new TemporarilyUnavailableError('try later')],
  ])('%s is transient — rethrown untouched, not NeedsReconnect', async (_name, make) => {
    const err = make();
    const caught = await run(async () => { throw err; }).catch((e: unknown) => e);
    expect(caught).toBe(err);
    expect(caught).not.toBeInstanceOf(NeedsReconnectError);
  });

  it('non-Error throwables (string, null) are transient too', async () => {
    await expect(run(async () => { throw 'invalid_grant'; })).rejects.toBe('invalid_grant');
    await expect(run(async () => { throw null; })).rejects.toBeNull();
  });
});

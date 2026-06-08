import { describe, expect, it } from 'vitest';
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

  it('throws NeedsReconnectError on invalid_grant', async () => {
    const resolve = createMcpOAuthResolver(deps({ refresh: async () => { throw new Error('invalid_grant'); } }));
    await expect(resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
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

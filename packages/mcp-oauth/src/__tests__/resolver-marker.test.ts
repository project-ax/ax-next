import {
  InvalidGrantError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpOAuthResolver, NeedsReconnectError, connectorIdOfRef } from '../resolver.js';
import { encodeTokenBlob } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-741: the stored "sign-in expired" marker the connectors rail reads.
// ---------------------------------------------------------------------------

const baseBlob = {
  accessToken: 'old', refreshToken: 'rt1', tokenType: 'Bearer', expiresAt: 0,
  scope: 'read', resource: 'https://mcp.example.com',
  authServerUrl: 'https://auth.example.com', tokenEndpoint: 'https://auth.example.com/token',
  clientKey: 'c|https://auth.example.com', clientId: 'cid',
};

function markerSpy(over: { mark?: () => Promise<void>; clear?: () => Promise<void> } = {}) {
  return {
    mark: vi.fn(over.mark ?? (async (_u: string, _c: string) => {})),
    clear: vi.fn(over.clear ?? (async (_u: string, _c: string) => {})),
  };
}

const deps = (over: Record<string, unknown> = {}) => ({
  store: { getClient: async () => null },
  refresh: async () => ({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600, token_type: 'Bearer' }),
  now: () => 10_000,
  ...over,
});

describe('mcp-oauth resolver — needs-reconnect marker (TASK-741)', () => {
  it('marks (user, connector) when the authorization server rejects the refresh', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({
      marker,
      refresh: async () => { throw new InvalidGrantError('revoked'); },
    }));
    await expect(resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u1', ref: 'account:gmail' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).toHaveBeenCalledTimes(1);
    expect(marker.mark).toHaveBeenCalledWith('u1', 'gmail');
    expect(marker.clear).not.toHaveBeenCalled();
  });

  it('marks when there is no refresh token left to use', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({ marker }));
    const { refreshToken: _rt, ...noRt } = baseBlob;
    await expect(resolve({ payload: encodeTokenBlob(noRt), userId: 'u1', ref: 'account:gmail' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).toHaveBeenCalledWith('u1', 'gmail');
  });

  it('does NOT mark on a transient refresh failure (the sign-in may be fine)', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({
      marker,
      refresh: async () => { throw new TemporarilyUnavailableError('busy'); },
    }));
    await expect(resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u1', ref: 'account:gmail' }))
      .rejects.not.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).not.toHaveBeenCalled();
    expect(marker.clear).not.toHaveBeenCalled();
  });

  it('clears the marker when a refresh succeeds', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({ marker }));
    const out = await resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u1', ref: 'account:gmail' });
    expect(out.value).toBe('new');
    expect(marker.clear).toHaveBeenCalledTimes(1);
    expect(marker.clear).toHaveBeenCalledWith('u1', 'gmail');
    expect(marker.mark).not.toHaveBeenCalled();
  });

  it('touches no marker when the stored token is still valid (no write on the hot path)', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({ marker }));
    const blob = encodeTokenBlob({ ...baseBlob, expiresAt: 10_000 + 10 * 60_000 });
    const out = await resolve({ payload: blob, userId: 'u1', ref: 'account:gmail' });
    expect(out.value).toBe('old');
    expect(marker.mark).not.toHaveBeenCalled();
    expect(marker.clear).not.toHaveBeenCalled();
  });

  it('a failing marker write never changes the resolve outcome', async () => {
    const boom = async () => { throw new Error('db down'); };
    const failing = markerSpy({ mark: boom, clear: boom });
    const rejecting = createMcpOAuthResolver(deps({
      marker: failing,
      refresh: async () => { throw new InvalidGrantError('revoked'); },
    }));
    await expect(rejecting({ payload: encodeTokenBlob(baseBlob), userId: 'u1', ref: 'account:gmail' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
    expect(failing.mark).toHaveBeenCalledTimes(1);
    const refreshing = createMcpOAuthResolver(deps({ marker: failing }));
    const out = await refreshing({ payload: encodeTokenBlob(baseBlob), userId: 'u1', ref: 'account:gmail' });
    expect(out.value).toBe('new');
    expect(failing.clear).toHaveBeenCalledTimes(1);
  });

  it('a ref that is not `account:<connectorId>` is never marked', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({
      marker,
      refresh: async () => { throw new InvalidGrantError('revoked'); },
    }));
    await expect(resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u1', ref: 'something-else' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).not.toHaveBeenCalled();
  });

  it('connectorIdOfRef reads only the `account:<slug>` shape', () => {
    expect(connectorIdOfRef('account:gmail')).toBe('gmail');
    expect(connectorIdOfRef('account:my-conn_2')).toBe('my-conn_2');
    expect(connectorIdOfRef('account:')).toBeNull();
    expect(connectorIdOfRef('account:Gmail')).toBeNull();
    expect(connectorIdOfRef('xaccount:gmail')).toBeNull();
    expect(connectorIdOfRef('account:gmail:extra')).toBeNull();
  });
});

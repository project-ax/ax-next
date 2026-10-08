import { InvalidGrantError, TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpOAuthResolver, NeedsReconnectError } from '../resolver.js';
import { encodeTokenBlob } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-817: the provider refused a stored, UNEXPIRED access token (revoked on
// its side, or the provider forgot it). The clock says the token is fine, so
// before this the resolver kept answering it: the rail said healthy and chat
// silently lost the tools. Now:
//   - a caller that saw the refusal asks again with `rejected: true`, and the
//     resolver renews instead of answering the stored token;
//   - a renewal the authorization server refuses is the existing "sign-in
//     expired" marker (needs-reconnect), on the token owner;
//   - while that marker stands, an unexpired token is not trusted either: the
//     next resolve (the next chat turn's proxy open) renews too, so it fails
//     with NeedsReconnectError instead of handing the dead token on.
// ---------------------------------------------------------------------------

const NOW = 10_000;
const unexpired = {
  accessToken: 'refused', refreshToken: 'rt1', tokenType: 'Bearer', expiresAt: NOW + 60 * 60_000,
  scope: 'read', resource: 'https://mcp.example.com',
  authServerUrl: 'https://auth.example.com', tokenEndpoint: 'https://auth.example.com/token',
  clientKey: 'c|https://auth.example.com', clientId: 'cid',
};

function markerSpy(marked = false) {
  return {
    mark: vi.fn(async (_o: unknown, _c: string) => {}),
    clear: vi.fn(async (_o: unknown, _c: string) => {}),
    isMarked: vi.fn(async (_o: unknown, _c: string) => marked),
  };
}

const deps = (over: Record<string, unknown> = {}) => ({
  store: { getClient: async () => null },
  refresh: vi.fn(async () => ({ access_token: 'renewed', refresh_token: 'rt2', expires_in: 3600, token_type: 'Bearer' })),
  now: () => NOW,
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  payload: encodeTokenBlob(unexpired),
  userId: 'u1',
  ref: 'account:gmail',
  // Slice 5 — every sign-in lives on an agent (the only rows with a marker).
  scope: 'agent' as const,
  ownerId: 'a1',
  ...over,
});

describe('mcp-oauth resolver — a refused unexpired token (TASK-817)', () => {
  it('rejected: renews an unexpired token instead of answering it, and clears the marker', async () => {
    const marker = markerSpy();
    const d = deps({ marker });
    const out = await createMcpOAuthResolver(d)(input({ rejected: true }));
    expect(out.value).toBe('renewed');
    expect(out.refreshed).toBeDefined();
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(marker.clear).toHaveBeenCalledWith({ kind: 'agent', agentId: 'a1' }, 'gmail');
  });

  it('rejected + the authorization server refuses the renewal → NeedsReconnectError and the owner is marked', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({
      marker,
      refresh: async () => { throw new InvalidGrantError('revoked'); },
    }));
    await expect(resolve(input({ rejected: true }))).rejects.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).toHaveBeenCalledWith({ kind: 'agent', agentId: 'a1' }, 'gmail');
  });

  it('rejected on a team (agent-scope) token marks the AGENT', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({
      marker,
      refresh: async () => { throw new InvalidGrantError('revoked'); },
    }));
    await expect(resolve(input({ rejected: true, scope: 'agent', ownerId: 'team-1' })))
      .rejects.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).toHaveBeenCalledWith({ kind: 'agent', agentId: 'team-1' }, 'gmail');
  });

  it('rejected with no refresh token → NeedsReconnectError (marked), never the refused token', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({ marker }));
    const { refreshToken: _drop, ...noRefresh } = unexpired;
    await expect(resolve(input({ rejected: true, payload: encodeTokenBlob(noRefresh) })))
      .rejects.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).toHaveBeenCalledTimes(1);
  });

  it('rejected + a transient renewal failure rethrows without marking', async () => {
    const marker = markerSpy();
    const resolve = createMcpOAuthResolver(deps({
      marker,
      refresh: async () => { throw new TemporarilyUnavailableError('busy'); },
    }));
    await expect(resolve(input({ rejected: true }))).rejects.not.toBeInstanceOf(NeedsReconnectError);
    expect(marker.mark).not.toHaveBeenCalled();
  });

  it('while the owner is marked, an ordinary resolve of an unexpired token renews too (the next turn fails loudly)', async () => {
    const marker = markerSpy(true);
    const resolve = createMcpOAuthResolver(deps({
      marker,
      refresh: async () => { throw new InvalidGrantError('revoked'); },
    }));
    await expect(resolve(input({ scope: 'agent', ownerId: 'team-1' }))).rejects.toBeInstanceOf(NeedsReconnectError);
    expect(marker.isMarked).toHaveBeenCalledWith({ kind: 'agent', agentId: 'team-1' }, 'gmail');
  });

  it('while marked, a renewal that now works heals it: new token, marker cleared', async () => {
    const marker = markerSpy(true);
    const d = deps({ marker });
    const out = await createMcpOAuthResolver(d)(input());
    expect(out.value).toBe('renewed');
    expect(marker.clear).toHaveBeenCalledTimes(1);
  });

  it('unmarked + unexpired + not rejected: answers the stored token with no network and no write', async () => {
    const marker = markerSpy(false);
    const d = deps({ marker });
    const out = await createMcpOAuthResolver(d)(input());
    expect(out).toEqual({ value: 'refused' });
    expect(d.refresh).not.toHaveBeenCalled();
    expect(marker.mark).not.toHaveBeenCalled();
    expect(marker.clear).not.toHaveBeenCalled();
  });

  it('a marker read that throws counts as unmarked (the plugin logs it); the stored token is answered', async () => {
    const marker = { ...markerSpy(), isMarked: vi.fn(async () => { throw new Error('db down'); }) };
    const d = deps({ marker });
    const out = await createMcpOAuthResolver(d)(input());
    expect(out.value).toBe('refused');
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('an expired token never reads the marker (it renews anyway)', async () => {
    const marker = markerSpy(false);
    await createMcpOAuthResolver(deps({ marker }))(input({ payload: encodeTokenBlob({ ...unexpired, expiresAt: 0 }) }));
    expect(marker.isMarked).not.toHaveBeenCalled();
  });
});

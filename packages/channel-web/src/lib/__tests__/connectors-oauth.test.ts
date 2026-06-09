import { describe, it, expect, vi, type Mock } from 'vitest';
import { beginOAuth, getOAuthStatus } from '../connectors-oauth';

describe('beginOAuth', () => {
  it('POSTs connectorId/agentId and returns authorizationUrl', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ authorizationUrl: 'https://p/auth' }), { status: 200 }),
    );
    expect(await beginOAuth({ connectorId: 'c', agentId: 'A' })).toEqual({
      authorizationUrl: 'https://p/auth',
    });
    const [url, init] = (fetch as Mock).mock.calls[0]!;
    expect(url).toBe('/api/connectors/oauth/begin');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      connectorId: 'c',
      agentId: 'A',
    });
  });

  it('omits agentId when not given', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ authorizationUrl: 'u' }), { status: 200 }),
    );
    await beginOAuth({ connectorId: 'c' });
    expect(
      JSON.parse(((fetch as Mock).mock.calls[0]![1] as RequestInit).body as string),
    ).toEqual({ connectorId: 'c' });
  });

  it('throws the server message on non-ok', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'oauth_discovery_failed' }), { status: 502 }),
    );
    await expect(beginOAuth({ connectorId: 'c' })).rejects.toThrow('oauth_discovery_failed');
  });
});

describe('getOAuthStatus', () => {
  it('GETs and returns the status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'needs-reconnect' }), { status: 200 }),
    );
    expect(await getOAuthStatus({ connectorId: 'c' })).toBe('needs-reconnect');
    expect((fetch as Mock).mock.calls[0]![0]).toContain(
      '/api/connectors/oauth/status?connectorId=c',
    );
  });

  it('includes agentId in the query when given', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'connected' }), { status: 200 }),
    );
    await getOAuthStatus({ connectorId: 'c', agentId: 'A' });
    expect((fetch as Mock).mock.calls[0]![0]).toContain('agentId=A');
  });
});

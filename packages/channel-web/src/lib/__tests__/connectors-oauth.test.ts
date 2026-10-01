import { describe, it, expect, vi, type Mock } from 'vitest';
import { beginOAuth, discoverOAuthHosts, getOAuthStatus } from '../connectors-oauth';

describe('discoverOAuthHosts', () => {
  it('POSTs only the draft URL, with authentication/CSRF headers and a cancellation signal', async () => {
    const signal = new AbortController().signal;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ hosts: ['accounts.google.com', 'oauth2.googleapis.com'] })));
    expect(await discoverOAuthHosts('https://gmailmcp.googleapis.com/mcp/v1', signal)).toEqual({ hosts: ['accounts.google.com', 'oauth2.googleapis.com'] });
    expect(fetch).toHaveBeenCalledWith('/api/connectors/oauth/discover-hosts', expect.objectContaining({
      method: 'POST', credentials: 'include', signal,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ url: 'https://gmailmcp.googleapis.com/mcp/v1' }),
    }));
  });

  it('returns a neutral discovery failure rather than reflecting provider content', async () => {
    globalThis.fetch = vi.fn(async () => new Response('untrusted response', { status: 502 }));
    await expect(discoverOAuthHosts('https://mcp.example.com')).rejects.toThrow('Retry or enter the hosts manually');
  });

  it.each([null, {}, { hosts: 'wrong' }, { hosts: [1] }, { hosts: [''] }, { hosts: Array(13).fill('example.com') }])('rejects an invalid host preview %j before it reaches the dialog', async (body) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body)));
    await expect(discoverOAuthHosts('https://mcp.example.com')).rejects.toThrow('Retry or enter the hosts manually');
  });
});

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

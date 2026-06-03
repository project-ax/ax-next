import { describe, it, expect, vi, afterEach } from 'vitest';
import { listChatAgents } from '../lib/agents.js';
import {
  getConnections,
  detachConnectionSkill,
  getAllowedSites,
  revokeAllowedSite,
  listAllAllowedSites,
  setSiteAgents,
} from '../lib/connections.js';

afterEach(() => vi.restoreAllMocks());

describe('agents + connections wire clients', () => {
  it('listChatAgents GETs /api/chat/agents', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([{ agentId: 'a1', displayName: 'Research', visibility: 'personal' }]),
        { status: 200 },
      ),
    );
    const agents = await listChatAgents();
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/agents', { credentials: 'include' });
    expect(agents).toEqual([{ agentId: 'a1', displayName: 'Research', visibility: 'personal' }]);
  });

  it('listChatAgents throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await expect(listChatAgents()).rejects.toThrow(/500/);
  });

  it('getConnections GETs /api/chat/connections/:agentId (url-encoded)', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ agentId: 'a/1', skills: [] }), { status: 200 }),
    );
    const out = await getConnections('a/1');
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/connections/a%2F1', {
      credentials: 'include',
    });
    expect(out).toEqual({ agentId: 'a/1', skills: [] });
  });

  it('detachConnectionSkill DELETEs with the CSRF header', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await detachConnectionSkill('a1', 'linear');
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/connections/a1/skills/linear', {
      method: 'DELETE',
      headers: { 'x-requested-with': 'ax-admin' },
      credentials: 'include',
    });
  });

  it('detachConnectionSkill throws on a non-204 error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await expect(detachConnectionSkill('a1', 'linear')).rejects.toThrow(/500/);
  });

  it('getAllowedSites GETs /api/chat/allowed-sites/:agentId (url-encoded)', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ agentId: 'a1', hosts: [{ host: 'x.example.com', grantedAt: 't' }] }),
        { status: 200 },
      ),
    );
    const out = await getAllowedSites('a1');
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/allowed-sites/a1', {
      credentials: 'include',
    });
    expect(out).toEqual({ agentId: 'a1', hosts: [{ host: 'x.example.com', grantedAt: 't' }] });
  });

  it('revokeAllowedSite DELETEs the (url-encoded) host with the CSRF header', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await revokeAllowedSite('a1', 'status.example.com');
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/allowed-sites/a1/status.example.com', {
      method: 'DELETE',
      headers: { 'x-requested-with': 'ax-admin' },
      credentials: 'include',
    });
  });

  it('revokeAllowedSite throws on a non-204 error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await expect(revokeAllowedSite('a1', 'x.example.com')).rejects.toThrow(/500/);
  });

  it('listAllAllowedSites GETs /api/chat/allowed-sites and returns the flat grants', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          grants: [
            { host: 'a.example.com', agentId: 'a1', grantedAt: 't' },
            { host: 'a.example.com', agentId: 'a2', grantedAt: 't' },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await listAllAllowedSites();
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/allowed-sites', { credentials: 'include' });
    expect(out).toEqual([
      { host: 'a.example.com', agentId: 'a1', grantedAt: 't' },
      { host: 'a.example.com', agentId: 'a2', grantedAt: 't' },
    ]);
  });

  it('setSiteAgents grants only newly-checked agents and revokes only unchecked ones', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ method: (init?.method as string) ?? 'GET', url: String(url) });
      return new Response(JSON.stringify({ created: true }), { status: 200 });
    });
    // Current: {a1, a2}; desired: {a1, a3} → grant a3 (POST), revoke a2 (DELETE); a1 untouched.
    await setSiteAgents('x.example.com', ['a1', 'a3'], ['a1', 'a2']);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(posts).toEqual(['/api/chat/allowed-sites/a3']);
    expect(deletes).toEqual(['/api/chat/allowed-sites/a2/x.example.com']);
    // a1 was in both sets → no call for it.
    expect(calls.some((c) => c.url.includes('/a1'))).toBe(false);
  });
});

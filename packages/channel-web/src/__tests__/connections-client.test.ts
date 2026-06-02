import { describe, it, expect, vi, afterEach } from 'vitest';
import { listChatAgents } from '../lib/agents.js';
import {
  getConnections,
  detachConnectionSkill,
  getAllowedSites,
  revokeAllowedSite,
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
});

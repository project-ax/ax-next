import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootstrapAgent } from '../lib/agent-bootstrap';

afterEach(() => vi.restoreAllMocks());

describe('bootstrapAgent', () => {
  it('POSTs to /api/agents/bootstrap with CSRF header + credentials and returns the agent', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify({ agent: { agentId: 'a9', displayName: 'Ada', visibility: 'personal' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const agent = await bootstrapAgent({ displayName: 'Ada', systemPrompt: 'You are Ada.' });
    expect(agent).toEqual({ agentId: 'a9', displayName: 'Ada', visibility: 'personal' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/agents/bootstrap');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-requested-with']).toBe('ax-admin');
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"create-failed"}', { status: 500 })));
    await expect(bootstrapAgent({ displayName: 'Ada', systemPrompt: '' })).rejects.toThrow();
  });
});

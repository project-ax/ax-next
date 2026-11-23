import { describe, it, expect, vi, afterEach } from 'vitest';
import { listAgentToolOptions } from '../admin';
import { PROD_TOOL_CATALOG } from './agent-tool-catalog.fixture';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

function reply(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

describe('listAgentToolOptions', () => {
  it('returns the catalog names and the built-ins', async () => {
    reply(200, PROD_TOOL_CATALOG);
    await expect(listAgentToolOptions()).resolves.toEqual(PROD_TOOL_CATALOG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/admin/agents/tools');
    expect(init.credentials).toBe('include');
  });

  it('rejects on a 503', async () => {
    reply(503, { error: 'tool-catalog-unavailable' });
    await expect(listAgentToolOptions()).rejects.toThrow();
  });

  it('a reply missing either list is a failed read, never an empty catalog', async () => {
    reply(200, { tools: [] });
    await expect(listAgentToolOptions()).rejects.toThrow();
    reply(200, { builtins: [] });
    await expect(listAgentToolOptions()).rejects.toThrow();
  });

  it('drops non-string entries', async () => {
    reply(200, { tools: ['routine_get', 7, null], builtins: ['Bash', {}] });
    await expect(listAgentToolOptions()).resolves.toEqual({
      tools: ['routine_get'],
      builtins: ['Bash'],
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { hydrateAgentsOnce } from '../lib/hydrate-agents';
import { agentStoreActions, getAgentStoreSnapshot } from '../lib/agent-store';

describe('hydrateAgentsOnce', () => {
  beforeEach(() => agentStoreActions.resetForTest());
  afterEach(() => vi.restoreAllMocks());

  it('maps the wire list and sets status ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify([
          { agentId: 'a1', displayName: 'Ada', visibility: 'personal' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));
    await hydrateAgentsOnce();
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('ready');
    expect(s.agents.map((a) => a.name)).toEqual(['Ada']);
  });

  it('sets status ready with an empty list when the user owns no agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    await hydrateAgentsOnce();
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('ready');
    expect(s.agents).toEqual([]);
  });

  it('sets status error on a non-ok response (does not force empty)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await hydrateAgentsOnce();
    expect(getAgentStoreSnapshot().agentsStatus).toBe('error');
  });

  it('sets status error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await hydrateAgentsOnce();
    expect(getAgentStoreSnapshot().agentsStatus).toBe('error');
  });
});

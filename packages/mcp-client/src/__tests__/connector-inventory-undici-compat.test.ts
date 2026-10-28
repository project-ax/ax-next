import { expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import { createGuardedFetch } from '../connector-inventory/safe-fetch.js';

const holder = vi.hoisted(() => ({ agent: null as import('undici').MockAgent | null }));

vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    // Replace only socket dispatch. Keep the installed fetch/handler protocol and
    // the guard's default fetch selection, response conversion and body reader.
    Agent: class extends actual.Agent {
      dispatch(...args: Parameters<InstanceType<typeof actual.Agent>['dispatch']>) {
        if (!holder.agent) throw new Error('Missing test dispatcher');
        return holder.agent.dispatch(...args);
      }
    },
  };
});

it('the guarded fetch works when Node bundles a different Undici major', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  holder.agent = agent;
  agent.get('https://inventory.example').intercept({ path: '/mcp', method: 'GET' })
    .reply(200, { tools: [] }, { headers: { 'content-type': 'application/json' } });
  const guarded = createGuardedFetch({ serverUrl: 'https://inventory.example/mcp', timeoutMs: 2000, maxResponseBytes: 512 });
  try {
    const response = await guarded.fetch('https://inventory.example/mcp');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tools: [] });
    agent.assertNoPendingInterceptors();
  } finally {
    await guarded.close();
    await agent.close();
    holder.agent = null;
  }
});

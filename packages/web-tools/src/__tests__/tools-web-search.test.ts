import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import { WEB_SEARCH_DESCRIPTOR, registerWebSearch } from '../tools/web-search.js';

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

describe('tools/web-search', () => {
  it('descriptor is a host tool named web_search requiring query', () => {
    expect(WEB_SEARCH_DESCRIPTOR.name).toBe('web_search');
    expect(WEB_SEARCH_DESCRIPTOR.executesIn).toBe('host');
    expect(WEB_SEARCH_DESCRIPTOR.inputSchema).toMatchObject({ required: ['query'] });
  });

  it('registers the descriptor via tool:register', async () => {
    const bus = new HookBus();
    let registered: ToolDescriptor | undefined;
    bus.registerService<ToolDescriptor, { ok: true }>('tool:register', 'disp', async (_c, d) => {
      registered = d;
      return { ok: true };
    });
    await registerWebSearch(bus, { run: vi.fn() });
    expect(registered?.name).toBe('web_search');
  });

  it('executor reads call.input.query and returns the bare search result', async () => {
    const bus = new HookBus();
    bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
    const run = vi.fn().mockResolvedValue({ query: 'cats', results: [{ title: 'A', url: 'https://a' }] });
    await registerWebSearch(bus, { run });

    // Host contract: the hook receives the FULL ToolCall { id, name, input }.
    const out = await bus.call('tool:execute:web_search', ctx(), {
      id: 'c1', name: 'web_search', input: { query: 'cats' },
    });
    expect(run).toHaveBeenCalledWith('cats');
    expect(out).toEqual({ query: 'cats', results: [{ title: 'A', url: 'https://a' }] });
  });

  it('rejects an empty query before calling the backend', async () => {
    const bus = new HookBus();
    bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
    const run = vi.fn();
    await registerWebSearch(bus, { run });
    await expect(
      bus.call('tool:execute:web_search', ctx(), { id: 'c', name: 'web_search', input: {} }),
    ).rejects.toThrow(/query/i);
    expect(run).not.toHaveBeenCalled();
  });
});

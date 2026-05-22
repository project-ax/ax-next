import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createToolDispatcherPlugin } from '@ax/mcp-client';
import { createWebToolsPlugin } from '../plugin.js';

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

// Stub Anthropic: web_search returns one hit; web_fetch returns text.
function stubClientFactory() {
  const create = vi.fn(async (req: { tools?: Array<{ type?: string }> }) => {
    const toolType = req.tools?.[0]?.type ?? '';
    if (toolType.startsWith('web_search')) {
      return {
        stop_reason: 'end_turn',
        content: [{
          type: 'web_search_tool_result', tool_use_id: 's',
          content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A', page_age: null, encrypted_content: 'X' }],
        }],
      };
    }
    return {
      stop_reason: 'end_turn',
      content: [{
        type: 'web_fetch_tool_result', tool_use_id: 's',
        content: { type: 'web_fetch_result', url: 'https://a.com', content: { type: 'document', title: 'A', source: { type: 'text', media_type: 'text/plain', data: 'hello' } } },
      }],
    };
  });
  return () => ({ messages: { create } }) as never;
}

describe('web-tools canary (real tool-dispatcher)', () => {
  it('both tools appear in tool:list and dispatch end-to-end', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: undefined });
    await createWebToolsPlugin({ apiKey: 'sk-ant-x', clientFactory: stubClientFactory() }).init({ bus, config: {} as never });

    const list = await bus.call<Record<string, never>, { tools: Array<{ name: string; executesIn: string }> }>(
      'tool:list', ctx(), {},
    );
    const byName = new Map(list.tools.map((t) => [t.name, t]));
    expect(byName.get('web_search')?.executesIn).toBe('host');
    expect(byName.get('web_extract')?.executesIn).toBe('host');

    const search = await bus.call('tool:execute:web_search', ctx(), { id: 'c1', name: 'web_search', input: { query: 'cats' } });
    expect(search).toMatchObject({ results: [{ title: 'A', url: 'https://a.com' }] });
    expect(JSON.stringify(search)).not.toContain('"X"');

    const extract = await bus.call('tool:execute:web_extract', ctx(), { id: 'c2', name: 'web_extract', input: { url: 'https://a.com' } });
    expect(extract).toMatchObject({ url: 'https://a.com', title: 'A', text: 'hello' });
  });
});

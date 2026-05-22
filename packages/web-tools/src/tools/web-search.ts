import { makeAgentContext, PluginError } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import type { WebSearchOutput } from '../anthropic-client.js';

const PLUGIN_NAME = '@ax/web-tools';

export const WEB_SEARCH_DESCRIPTOR: ToolDescriptor = {
  name: 'web_search',
  description:
    'Search the live web and get back a list of result hits (title + URL) plus a short summary. ' +
    'Use when you need current information beyond your training data.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
};

/** Backend seam — supplied by the plugin so tests can stub the Anthropic call. */
export interface WebSearchBackend {
  run(query: string): Promise<WebSearchOutput>;
}

export async function registerWebSearch(bus: HookBus, backend: WebSearchBackend): Promise<void> {
  const ctx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', ctx, WEB_SEARCH_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, WebSearchOutput>(
    'tool:execute:web_search',
    PLUGIN_NAME,
    async (_ctx, call) => {
      const input = (call?.input ?? {}) as { query?: unknown };
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length === 0) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:web_search',
          message: 'web_search requires a non-empty "query"',
        });
      }
      return backend.run(query);
    },
    { timeoutMs: 120_000 },
  );
}

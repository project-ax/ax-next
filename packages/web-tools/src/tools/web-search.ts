import { makeAgentContext, PluginError } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import type { WebSearchOutput } from '../anthropic-client.js';

const PLUGIN_NAME = '@ax/web-tools';

export const WEB_SEARCH_DESCRIPTOR: ToolDescriptor = {
  name: 'web_search',
  description:
    'Search the live web and get back a list of result hits (title + URL) plus a short summary. ' +
    'Use when you need current information beyond your training data.',
  activityPhrase: 'Searching the web',
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
    // `stallWarnMs` raised above the bus's 15s default (TASK-505). The test is
    // whether running long is NORMAL, not merely possible — and it is here: a
    // server-side search fans out into several queries against a third party we
    // don't control, so tens of seconds is an ordinary healthy result, not a
    // symptom. Warning at 15s would fire on the good case and teach everyone to
    // filter the message. Half the declared timeout keeps the line rare and
    // still leaves 60s to notice a genuinely wedged call.
    { timeoutMs: 120_000, stallWarnMs: 60_000 },
  );
}

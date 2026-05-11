import { makeAgentContext } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import { retrieve } from '../retriever.js';

const PLUGIN_NAME = '@ax/memory-strata';

export const MEMORY_SEARCH_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_search',
  description:
    'Search long-term memory. Returns document summaries (~50 tokens each). ' +
    'Use this BEFORE asserting facts about durable preferences, decisions, or known entities.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language search.' },
      categoryFilter: {
        type: 'string',
        description: 'Optional. One of: entity | preference | decision | episode | general',
      },
      topK: { type: 'number', description: 'Default 5; max 20.' },
    },
    required: ['query'],
  },
};

export async function registerMemorySearch(bus: HookBus): Promise<void> {
  // Register descriptor with the catalog via tool:register service hook.
  // makeAgentContext() builds a synthetic ctx for init-time registrations
  // (mirrors mcp-client / tool-dispatcher pattern).
  const ctx = makeAgentContext({
    sessionId: 'init',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });
  await bus.call('tool:register', ctx, MEMORY_SEARCH_DESCRIPTOR);

  // Register the host-side executor. The catalog (tool-dispatcher) holds the
  // descriptor; this service hook is what the agent's tool.execute-host call
  // routes to.
  bus.registerService<
    { query?: unknown; topK?: unknown; categoryFilter?: unknown },
    { results: Array<{ docId: string; category: string; slug: string; summary: string; score: number }> }
  >(
    'tool:execute:memory_search',
    PLUGIN_NAME,
    async (ctx, input) => {
      const topKRaw = Number(input?.topK ?? 5);
      const topK = Number.isFinite(topKRaw)
        ? Math.max(1, Math.min(Math.trunc(topKRaw), 20))
        : 5;
      const query = typeof input?.query === 'string' ? input.query : '';
      const categoryFilter =
        typeof input?.categoryFilter === 'string' ? input.categoryFilter : undefined;
      const results = await retrieve(bus, ctx, {
        query,
        topK,
        ...(categoryFilter !== undefined ? { categoryFilter } : {}),
      });
      return { results };
    },
  );
}

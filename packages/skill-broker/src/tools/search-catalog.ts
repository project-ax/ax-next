import { makeAgentContext, type HookBus, type ToolDescriptor } from '@ax/core';

const PLUGIN_NAME = '@ax/skill-broker';

export const SEARCH_CATALOG_DESCRIPTOR: ToolDescriptor = {
  name: 'search_catalog',
  description:
    'Search the capability catalog for skills that match what you are trying to do ' +
    '(e.g. "read my Linear issues"). Returns candidate skills, the hosts each reaches, ' +
    'and any credential slots it needs. Call this before request_capability.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'What you are trying to accomplish, in plain language.',
      },
    },
    required: ['intent'],
  },
};

// Mirrors @ax/skills' CatalogCandidate shape locally — the broker forwards the
// hook's result verbatim and must not import across the plugin boundary (I2).
interface CatalogCandidate {
  id: string;
  description: string;
  tier: string;
  hosts: string[];
  slots: string[];
}
interface SearchCatalogResult {
  skills: CatalogCandidate[];
}

export async function registerSearchCatalog(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, SEARCH_CATALOG_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, SearchCatalogResult>(
    'tool:execute:search_catalog',
    PLUGIN_NAME,
    async (toolCtx, call) => {
      const input = (call?.input ?? {}) as { intent?: unknown };
      const intent = typeof input.intent === 'string' ? input.intent : '';
      // The catalog owner does the matching + tier derivation (one source of truth).
      return bus.call<{ intent: string }, SearchCatalogResult>(
        'skills:search-catalog',
        toolCtx,
        { intent },
      );
    },
    { timeoutMs: 30_000 },
  );
}

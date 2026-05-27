import { makeAgentContext, type HookBus, type ToolDescriptor } from '@ax/core';
import { clampNeed, deriveColdStartSlug, fireColdStartSubmit } from './coldstart.js';

const PLUGIN_NAME = '@ax/skill-broker';

export const SEARCH_CATALOG_DESCRIPTOR: ToolDescriptor = {
  name: 'search_catalog',
  description:
    'Search the capability catalog for skills that match what you are trying to do ' +
    '(e.g. "read my Linear issues"). Returns candidate skills, the hosts each reaches, ' +
    'and any credential slots it needs. Call this before request_capability. ' +
    'If the result is empty ({ skills: [] }), the catalog has nothing for that need yet ' +
    'and a request to add it has already been filed for the administrator — tell the user ' +
    'you have asked your admin to add it and that you will be able to help once it is approved. ' +
    'That is the expected outcome, not an error.',
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
      const result = await bus.call<{ intent: string }, SearchCatalogResult>(
        'skills:search-catalog',
        toolCtx,
        { intent },
      );

      // Cold-start (design §13): the catalog matched nothing for a real intent —
      // file a deduped admit-queue request so the unmet need reaches the admin.
      // The free-text intent is UNTRUSTED model output: it rides only as the
      // request description (data an admin triages, never a manifest), clamped to
      // a bounded length; the dedup slug is derived + re-validated locally (I5).
      // Best-effort: a failed/absent submit never changes this (empty) result.
      // An empty/whitespace intent is no signal — file nothing.
      if (result.skills.length === 0 && intent.trim().length > 0) {
        await fireColdStartSubmit(bus, toolCtx, {
          skillId: deriveColdStartSlug(intent),
          description: clampNeed(intent),
        });
      }

      return result;
    },
    { timeoutMs: 30_000 },
  );
}

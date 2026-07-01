import { makeAgentContext } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import { readInjectedMapBody } from '../inject.js';
import {
  DEFAULT_ORCHESTRATOR_TIMEOUT_MS,
  runOrchestratedRetrieve,
  type OrchestratorClient,
} from '../orchestrator.js';
import { retrieve } from '../retriever.js';

const PLUGIN_NAME = '@ax/memory-strata';

/**
 * Optional orchestrator wiring for `registerMemorySearch` (TASK-191 Task 3).
 * Passed through from `MemoryStrataConfig.orchestrator` / `.retrievalMode` —
 * see plugin.ts. Both fields optional so the existing `registerMemorySearch(bus)`
 * call (tests, any harness that hasn't opted in) keeps its byte-identical
 * pure-BM25 behavior.
 */
export interface RegisterMemorySearchOptions {
  retrievalMode?: 'orchestrator' | 'bm25';
  orchestrator?: { client: OrchestratorClient; timeoutMs?: number };
}

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

export async function registerMemorySearch(
  bus: HookBus,
  opts?: RegisterMemorySearchOptions,
): Promise<void> {
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
    { input?: unknown },
    { results: Array<{ docId: string; category: string; slug: string; summary: string; score: number }> }
  >(
    'tool:execute:memory_search',
    PLUGIN_NAME,
    async (ctx, call) => {
      // The `tool.execute-host` IPC handler forwards the full ToolCall
      // `{ id, name, input }` to this hook (see ipc-core tool-execute-host.ts).
      // The model-supplied arguments live under `call.input`, not on `call`.
      const input = (call?.input ?? {}) as {
        query?: unknown;
        topK?: unknown;
        categoryFilter?: unknown;
      };
      const topKRaw = Number(input?.topK ?? 5);
      const topK = Number.isFinite(topKRaw)
        ? Math.max(1, Math.min(Math.trunc(topKRaw), 20))
        : 5;
      const query = typeof input?.query === 'string' ? input.query : '';
      const categoryFilter =
        typeof input?.categoryFilter === 'string' ? input.categoryFilter : undefined;

      // TASK-191 Task 3: memory_search is the query-time seam — unlike
      // chat-start inject (see inject.ts's design note), a tool call always
      // carries a query. That's what lets the orchestrator run here: it reads
      // the already-injected, densified `system/map.md` + this query and picks
      // the right doc(s) to load, with BM25 as the fallback on a miss/timeout.
      // A `categoryFilter` means the caller already knows the scoped BM25
      // intent (e.g. "list all preferences") — orchestrating over the map
      // would be pure overhead, so we skip straight to BM25 in that case.
      if (
        opts?.orchestrator?.client !== undefined &&
        (opts.retrievalMode ?? 'orchestrator') !== 'bm25' &&
        query.length > 0 &&
        categoryFilter === undefined
      ) {
        const mapBody = await readInjectedMapBody(bus, ctx, ctx.workspace.rootPath);
        const orchestrated = await runOrchestratedRetrieve({
          client: opts.orchestrator.client,
          mapBody,
          query,
          topK,
          timeoutMs: opts.orchestrator.timeoutMs ?? DEFAULT_ORCHESTRATOR_TIMEOUT_MS,
          ftsSearch: (q, k) => retrieve(bus, ctx, { query: q, topK: k }),
          logger: ctx.logger,
        });
        if (orchestrated !== null) return { results: orchestrated };
        // else: fall through to plain BM25 below (empty map, timeout, or every
        // emitted op resolved to nothing).
      }

      const results = await retrieve(bus, ctx, {
        query,
        topK,
        ...(categoryFilter !== undefined ? { categoryFilter } : {}),
      });
      return { results };
    },
  );
}

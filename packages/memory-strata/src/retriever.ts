// Thin client over `memory:index:search`. Calls the indexer service hook
// and returns [] when the indexer isn't registered — keeps test harnesses
// and isolation cases working without forcing every preset to wire an indexer.
// Defense in depth: the plugin manifest declares a hard dependency on the
// indexer, but the retriever gracefully degrades if a subscriber calls it
// before the service is ready.

import type { HookBus, AgentContext } from '@ax/core';

/**
 * Input to the retrieve function. `query` is required; `topK` defaults to 5;
 * `categoryFilter` is optional and forwarded to the indexer.
 */
export interface RetrieveInput {
  query: string;
  topK?: number;
  categoryFilter?: string;
}

/**
 * Single search result returned by the indexer. `score` is the search rank.
 * `snippet` is a bounded, query-matched excerpt of the doc body (2026-07-01
 * memory-search-snippet design) — surfaced alongside `summary` so the agent
 * sees the actual value without a second `memory_read_section` call.
 */
export interface RetrievalResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  score: number;
}

/**
 * Internal: the shape the `memory:index:search` service hook returns.
 */
interface SearchHookOutput {
  results: RetrievalResult[];
}

/**
 * Call the `memory:index:search` service hook to retrieve facts matching
 * a query. Returns [] when the indexer service isn't registered — this
 * allows test harnesses and isolated code paths to call retrieve() without
 * forcing every preset to wire the indexer.
 *
 * `topK` defaults to 5 if not provided. `categoryFilter` is forwarded
 * to the indexer when set; omitted from the hook input when undefined.
 */
export async function retrieve(
  bus: HookBus,
  ctx: AgentContext,
  input: RetrieveInput,
): Promise<RetrievalResult[]> {
  if (!bus.hasService('memory:index:search')) return [];

  const hookInput: {
    query: string;
    topK: number;
    categoryFilter?: string;
  } = {
    query: input.query,
    topK: input.topK ?? 5,
  };

  if (input.categoryFilter !== undefined) {
    hookInput.categoryFilter = input.categoryFilter;
  }

  const out = await bus.call<
    typeof hookInput,
    SearchHookOutput
  >('memory:index:search', ctx, hookInput);

  return out.results;
}

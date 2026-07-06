import { makeAgentContext } from '@ax/core';
import type { AgentContext, HookBus, ToolDescriptor } from '@ax/core';
import { readDocBody } from '../doc-body.js';
import { parseDocId } from '../doc-id.js';
import { readInjectedMapBody } from '../inject.js';
import { extractMatchedFacts } from '../matched-facts.js';
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
    'Search long-term memory. Each hit carries a one-line summary, a `snippet` ' +
    '(match-centered body excerpt), and `matchedFacts` — query-matching fact ' +
    'lines from that doc, with dates like (2026-02-15) when known. matchedFacts ' +
    'is a CAPPED PREVIEW, not the full set: a "⋯ more matching lines" entry means ' +
    'the doc has more instances than shown — call memory_read_section on that doc ' +
    'to read them all. For counting/enumeration questions ("how many X"), do NOT ' +
    'conclude a count from the first search: read matchedFacts across ALL hits, ' +
    'drill into any truncated doc, AND run more searches with instance-specific ' +
    'terms (e.g. for "citrus" also try "lime", "lemon") before answering. Count ' +
    'only distinct instances — ignore near-duplicate lines describing the same event.',
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
    {
      results: Array<{
        docId: string;
        category: string;
        slug: string;
        summary: string;
        snippet: string;
        score: number;
        matchedFacts: string[];
      }>;
    }
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
        // The BM25 fallback is the WHOLE contract of this path, so the orchestrator
        // attempt must NEVER throw out of the executor — a throw would surface a
        // failed tool call to the agent instead of degrading to BM25. Two escape
        // hatches motivate the outer try/catch: (1) `readInjectedMapBody` re-throws
        // a non-ENOENT fs error (map.md exists but is unreadable) — a net-new read
        // this path introduced; (2) `runOrchestratedRetrieve` catches its own LLM
        // call but runs the `<fts>` op's `ftsSearch` OUTSIDE that guard, so a
        // rejecting indexer would propagate. On any throw we log and fall through
        // to plain BM25 below (mirroring registerInject's system-prompt:augment
        // handler, which guards `buildMemoryBlock` the same way). A null return
        // (empty map / timeout / every emitted op resolved to nothing) also falls
        // through.
        try {
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
          if (orchestrated !== null) {
            return { results: await withMatchedFacts(bus, ctx, orchestrated, query) };
          }
        } catch (err) {
          ctx.logger.warn('memory_strata_orchestrator_failed', {
            err: err instanceof Error ? err : new Error(String(err)),
            agentId: ctx.agentId,
          });
        }
      }

      const results = await retrieve(bus, ctx, {
        query,
        topK,
        ...(categoryFilter !== undefined ? { categoryFilter } : {}),
      });
      return { results: await withMatchedFacts(bus, ctx, results, query) };
    },
  );
}

// WS-A early-termination fix (diagnosis 2026-07-05). Was 20 — a full first
// search result that big read as *exhaustive* to the answer model, so it
// stopped after 1–2 searches and under-sampled counting questions (lost cases
// did FEWER tool-calls, 4.4→2.8). Capping lower means a doc with many instances
// no longer looks complete from one hit; the truncation marker below makes that
// incompleteness explicit so the model drills in / keeps searching before it
// counts, instead of silently mistaking 6 lines for the whole set.
const MAX_FACTS_PER_DOC = 6;
const MAX_FACTS_PER_RESPONSE = 60;

/** Build the trailing "there's more in this doc" marker appended to a row's
 * matchedFacts when its body had more query-matching lines than we showed. Kept
 * unambiguous so the answer model reads it as an instruction, never as another
 * countable instance: it opens with a non-fact sentinel and names the drill-in
 * tool + docId. */
function truncationMarker(docId: string): string {
  return `⋯ more matching lines in ${docId} not shown — call memory_read_section on it to read them all before counting.`;
}

/** D2 (enumeration design): attach every query-matching fact line from each
 * hit's body. Best-effort — a read failure yields [] for that row, never a
 * failed tool call. Applies to orchestrator `<load>` rows too (their doc
 * bodies never touched the index).
 *
 * WS-A: when a doc has more matching lines than we can show (per-doc cap or the
 * shared response budget), append `truncationMarker` so the truncation is
 * legible instead of silently reading as an exhaustive set. */
async function withMatchedFacts<
  R extends { docId: string },
>(bus: HookBus, ctx: AgentContext, rows: R[], query: string): Promise<Array<R & { matchedFacts: string[] }>> {
  const out: Array<R & { matchedFacts: string[] }> = [];
  let total = 0;
  for (const row of rows) {
    let matchedFacts: string[] = [];
    if (total < MAX_FACTS_PER_RESPONSE && query.length > 0) {
      try {
        const parsed = parseDocId(row.docId);
        const body = parsed === null
          ? null
          : await readDocBody(bus, ctx, parsed.category, parsed.slug);
        if (body !== null) {
          const cap = Math.min(MAX_FACTS_PER_DOC, MAX_FACTS_PER_RESPONSE - total);
          // Probe one line past the cap: if extract returns more than `cap`,
          // the doc was truncated and we append the marker. Cheap (one extra
          // line scanned) and needs no return-shape change.
          const probed = extractMatchedFacts(body, query, { maxLines: cap + 1 });
          matchedFacts = probed.slice(0, cap);
          total += matchedFacts.length;
          if (probed.length > cap) {
            matchedFacts.push(truncationMarker(row.docId));
          }
        }
      } catch (err) {
        ctx.logger.warn('memory_strata_matched_facts_failed', {
          err: err instanceof Error ? err : new Error(String(err)),
          docId: row.docId,
        });
      }
    }
    out.push({ ...row, matchedFacts });
  }
  return out;
}

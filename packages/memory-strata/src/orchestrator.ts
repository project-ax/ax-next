// The retrieval orchestrator (TASK-191, promoting the bench's proven config
// E from test/bench/orchestrator.ts into the runtime). A cheap-LLM stage
// that reads the always-injected `system/map.md` + the turn's query, and
// decides which memory docs to load — instead of falling straight to a BM25
// keyword search. The corrected n=500 spike
// (docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md) found
// orchestrator + BM25-fallback + a densified map beats BM25-only by +7.6pp
// accuracy / +14.2pp recall@5.
//
// This module is PURE LOGIC — no HookBus, no fetch, no filesystem. The
// `OrchestratorClient` is injected by the caller (see orchestrator-client.ts
// for the fetch-based implementations, and plugin.ts / memory-search.ts for
// the wiring, TASK-191 Task 3). That separation is what makes this file
// test-driveable with a stub client and no network.
//
// Security posture (untrusted-content boundary — see CLAUDE.md invariant 5):
// map summaries derive from prior, possibly-untrusted conversation content,
// and get fed straight into the orchestrator LLM's prompt. The LLM's response
// is therefore treated as untrusted at every hop: `parseOrchestratorPlan`
// recognizes ONLY the `<load>`/`<fts>`/`<followup>` tags via a strict regex
// (no prose, no other tags reach the op list), and every `load` docId is run
// through the SAME traversal guard (`parseDocId`, doc-id.ts) the
// `memory_read_section` tool uses, AND must additionally match an entry
// already present in the agent's own map. A crafted injection can therefore
// at most cause a load of one of the agent's OWN existing docs — never an
// escape, never a cross-tenant read.

import { parseDocId } from './doc-id.js';
import type { RetrievalResult } from './retriever.js';
import { raceTimeout } from './timeout.js';

/**
 * Narrow client interface for the orchestrator's one-shot completion call.
 * Deliberately NOT `LlmCallInput`/`LlmCallOutput` (the host-LLM gate used
 * elsewhere in this package) — the orchestrator is a standalone host-side
 * egress to a specific cheap model (xAI direct or OpenRouter), gated by its
 * own API key, not routed through the agent's configured provider.
 */
export interface OrchestratorClient {
  complete(args: { system: string; user: string }): Promise<{
    text: string;
    usage: { in: number; out: number };
  }>;
}

export type OrchestratorOp =
  | { kind: 'load'; docId: string; section?: string }
  | { kind: 'fts'; query: string };

export interface OrchestratorPlan {
  ops: OrchestratorOp[];
  followupNeeded: boolean;
}

/** Default hard deadline for the orchestrator's LLM round-trip (ms). */
export const DEFAULT_ORCHESTRATOR_TIMEOUT_MS = 5000;

const SYSTEM = `You are a retrieval planner. You read a memory map (a flat listing of every
document in the agent's memory, one line per doc, with a one-line summary)
and a user query, and decide which documents the agent should load before
answering.

You output ONLY XML, using these tags:

  <load doc="<docId>"/>                  — load a document into context
  <fts query="..."/>                     — when you genuinely cannot decide
                                            from the map alone, run a keyword
                                            search (max 1-2 of these per query)
  <followup needed="true"/>              — emit when you suspect one hop
                                            won't be enough (e.g., cross-doc
                                            aggregation, "what was X before we
                                            changed it")

Rules:
- Emit between 1 and 5 ops total. Prefer the smallest precise set.
- doc ids must exactly match entries in the map (e.g. "preference/coffee").
- Do not output prose, code fences, or explanations. Only the XML ops.`;

// ---------------------------------------------------------------------------
// Plan parsing — strict regex, ported from test/bench/orchestrator.ts
// (parseOrchestratorXml). Only <load>/<fts>/<followup> are recognized; any
// other tag or prose the model emits is silently ignored rather than parsed.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```[a-z]*\n?|\n?```$/g;
const LOAD_RE = /<load\s+([^>]*?)\/?>/gi;
const FTS_RE = /<fts\s+([^>]*?)\/?>/gi;
const FOLLOWUP_RE = /<followup\s+[^>]*needed=["']?true["']?[^>]*\/?>/i;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseOrchestratorPlan(text: string): OrchestratorPlan {
  const stripped = text.replace(FENCE_RE, '').trim();
  const ops: OrchestratorOp[] = [];

  for (const m of stripped.matchAll(LOAD_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (attrs.doc) {
      ops.push({
        kind: 'load',
        docId: attrs.doc,
        ...(attrs.section ? { section: attrs.section } : {}),
      });
    }
  }
  for (const m of stripped.matchAll(FTS_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (attrs.query) ops.push({ kind: 'fts', query: attrs.query.trim() });
  }
  return { ops, followupNeeded: FOLLOWUP_RE.test(stripped) };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const name = m[1]!;
    const raw = m[2] ?? m[3] ?? '';
    out[name] = decodeEntities(raw);
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/**
 * Decode the five predefined XML entities in a SINGLE left-to-right pass. A
 * chained `.replace()` sequence (unescape `&amp;`→`&` first, then `&lt;`→`<`,
 * …) double-unescapes — e.g. the escaped literal `&amp;lt;` would become `&lt;`
 * and then `<`. One global regex + a lookup map replaces each entity exactly
 * once over the ORIGINAL string, so a `&` produced by decoding `&amp;` is never
 * re-scanned. This is untrusted LLM output (attribute values from the
 * orchestrator's response), so getting the decode unambiguously right matters.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

// ---------------------------------------------------------------------------
// Map parsing — the runtime `system/map.md` body format (map.ts renderBody):
//   # Memory Map
//
//   ## <category>/
//   - <slug>: <summary>
// ---------------------------------------------------------------------------

export interface MapEntry {
  docId: string;
  category: string;
  slug: string;
  summary: string;
}

const CATEGORY_HEADER_RE = /^##\s+(.+?)\/\s*$/;
const ENTRY_RE = /^-\s+([^:]+):\s*(.*)$/;

/**
 * Parse `system/map.md`'s body into a flat entry list. Skips the `# Memory
 * Map` heading, blank lines, and the empty-map sentinel `_No memory yet._`.
 * An entry whose `<category>/<slug>` fails the shared traversal guard
 * (`parseDocId`) is dropped defensively — the map is a derived/cached file,
 * but this keeps the orchestrator's input on the same trust footing as every
 * other docId consumer in this package.
 */
export function parseMapEntries(mapBody: string): MapEntry[] {
  const out: MapEntry[] = [];
  let currentCategory: string | null = null;

  for (const rawLine of mapBody.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line === '# Memory Map') continue;
    if (line === '_No memory yet._') continue;

    const catMatch = CATEGORY_HEADER_RE.exec(line);
    if (catMatch) {
      currentCategory = catMatch[1]!.trim();
      continue;
    }
    if (currentCategory === null) continue;

    const entryMatch = ENTRY_RE.exec(line);
    if (!entryMatch) continue;
    const slug = entryMatch[1]!.trim();
    const summary = entryMatch[2]!.trim();
    const docId = `${currentCategory}/${slug}`;
    if (parseDocId(docId) === null) continue;

    out.push({ docId, category: currentCategory, slug, summary });
  }

  return out;
}

/**
 * Render the parsed map entries as a flat listing for the orchestrator's
 * prompt — one line per doc, `- <docId>: <summary>` — so the LLM sees the
 * exact docIds it must echo back in `<load doc="...">`.
 */
export function renderMapForOrchestrator(entries: MapEntry[]): string {
  return entries.map((e) => `- ${e.docId}: ${e.summary}`).join('\n');
}

// ---------------------------------------------------------------------------
// runOrchestratedRetrieve — the end-to-end pure-logic entry point
// ---------------------------------------------------------------------------

export interface RunOrchestratedRetrieveDeps {
  client: OrchestratorClient;
  mapBody: string;
  query: string;
  topK: number;
  timeoutMs: number;
  ftsSearch: (query: string, topK: number) => Promise<RetrievalResult[]>;
  logger?: { warn(event: string, fields: Record<string, unknown>): void };
}

/**
 * Run the orchestrator: LLM(map, query) → whitelisted ops → resolved rows.
 * Returns `null` whenever the caller should fall back to plain BM25:
 *   - the map is empty (nothing to orchestrate over),
 *   - the LLM call throws or exceeds `timeoutMs`,
 *   - or every emitted op resolved to nothing (hallucinated docId, empty
 *     fts hits, unparseable response).
 * A `load` op's docId must pass BOTH the traversal guard (`parseDocId`) AND
 * exist in the agent's own map table — a docId matching neither is skipped,
 * not surfaced. `load` results always win a dedup race against a later `fts`
 * hit for the same docId (loads are pushed to `out` first, in emission
 * order), matching the bench's proven config E.
 */
export async function runOrchestratedRetrieve(
  deps: RunOrchestratedRetrieveDeps,
): Promise<RetrievalResult[] | null> {
  const entries = parseMapEntries(deps.mapBody);
  if (entries.length === 0) return null;

  const table = new Map<string, MapEntry>();
  for (const entry of entries) table.set(entry.docId, entry);

  const user = `## Memory Map\n${renderMapForOrchestrator(entries)}\n\n## Query\n${deps.query}\n\n## Output\n`;

  let text: string;
  try {
    const resp = await raceTimeout(
      deps.client.complete({ system: SYSTEM, user }),
      deps.timeoutMs,
      'orchestrator',
    );
    text = resp.text;
  } catch (err) {
    deps.logger?.warn('memory_strata_orchestrator_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }

  const plan = parseOrchestratorPlan(text);
  // Single-hop by design (config E): we execute the plan's ops once and never
  // re-plan. `plan.followupNeeded` is parsed but deliberately NOT consumed here —
  // it's a forward-looking signal reserved for a future multi-hop retrieval
  // phase; wiring a second hop is out of scope for this card.
  const out = await runOps(plan.ops, table, deps.topK, deps.ftsSearch);

  if (out.length === 0) return null;
  return out.slice(0, deps.topK);
}

async function runOps(
  ops: OrchestratorOp[],
  table: Map<string, MapEntry>,
  topK: number,
  ftsSearch: RunOrchestratedRetrieveDeps['ftsSearch'],
): Promise<RetrievalResult[]> {
  const seen = new Set<string>();
  const out: RetrievalResult[] = [];

  for (const op of ops) {
    if (op.kind === 'load') {
      // NOTE: `op.section`, if the planner emitted it, is intentionally NOT
      // honored — memory_search returns doc SUMMARIES (its tool contract) and
      // the agent drills into a specific section afterwards via the
      // memory_read_section tool. The prompt no longer advertises `section`.
      if (parseDocId(op.docId) === null) continue; // traversal guard
      const entry = table.get(op.docId);
      if (entry === undefined || seen.has(entry.docId)) continue;
      seen.add(entry.docId);
      out.push({
        docId: entry.docId,
        category: entry.category,
        slug: entry.slug,
        summary: entry.summary,
        score: 1,
      });
      if (out.length >= topK) return out;
    } else {
      const hits = await ftsSearch(op.query, topK);
      for (const hit of hits) {
        if (seen.has(hit.docId)) continue;
        seen.add(hit.docId);
        out.push(hit);
        if (out.length >= topK) return out;
      }
    }
  }

  return out;
}

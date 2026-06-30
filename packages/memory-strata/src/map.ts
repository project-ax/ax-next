// Regenerates `permanent/memory/system/map.md` — the always-injected
// hierarchical memory index (TASK-190). It is a DERIVED, cached view of the
// `docs/<category>/<slug>.md` tree, exactly like `recent.md`: one densified
// one-liner per doc, grouped by category. Deleting it loses nothing — the next
// consolidation pass regenerates it.
//
// WHY a map at all: the n=500 retrieval spike
// (docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md) found the
// always-in-context map — and specifically LLM-DENSIFIED one-line summaries
// (~120 chars of fact, e.g. "User commutes 45min to Boston; prefers Tesla over
// BMW") instead of the chitchat first sentence of a doc — to be the load-bearing
// retrieval lever: recall@5 47.6% → 56.0%, accuracy +7.6pp over BM25-only,
// correct-refusal 70% → 81.5%. The map gives the agent a single cheap glance at
// "what do I know, and roughly where", complementing per-turn `memory_search`.
//
// Determinism (mirrors recent.md's I13): given the same `now`, the same doc
// tree, and the same densifier output, repeated calls produce byte-for-byte
// identical map.md. This module enforces that by:
//   1. Sorting categories and slugs before serialising (fs readdir order never
//      leaks in).
//   2. Using `now` exclusively for frontmatter timestamps — no `Date.now()`.
//   3. Never reading map.md itself as input (avoids a read-your-own-write
//      divergence from a partially written prior file).
//
// Densification is INCREMENTAL and OPTIONAL:
//   - Incremental: each doc's densified one-liner is cached in a sidecar
//     (`system/.map-cache.json`) keyed by doc id, with a hash of the doc's
//     source facts. An unchanged doc is served from cache — never re-sent to
//     the LLM (the bench rewrite was ~$0.0002/session; the cache makes repeat
//     passes free).
//   - Optional: when no densifier is supplied (CI / no API keys / LLM down) the
//     map falls back to the doc's frontmatter `summary`. The map is ALWAYS
//     produced; densification only improves its content. A densifier that
//     throws on one doc degrades that doc to its raw summary and continues —
//     we never abort the whole pass for one bad call.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LlmCallInput, LlmCallOutput } from '@ax/core';
import { buildMarkdownFile } from './frontmatter.js';
import { listDocs } from './doc-store.js';
import { filterSensitive } from './sensitive-gate.js';
import { raceTimeout } from './timeout.js';
import { mapFile, mapCacheFile, type DocCategory } from './paths.js';
import type { DocFile, MemoryFrontmatter } from './types.js';

/** Default soft cap on each densified one-liner (chars). Matches the bench. */
export const MAP_SUMMARY_MAX_CHARS = 120;

/**
 * System prompt for the densifier. Lifted verbatim from the bench's proven
 * `test/bench/map-rewrite.ts` REWRITE_SYSTEM — the n=500 spike validated this
 * exact instruction set (recall@5 47.6% → 56.0%). One-line, fact-focused,
 * ≤120 chars, skip chitchat/greetings.
 */
const DENSIFY_SYSTEM = `You are summarizing a single memory document for an agent's structured memory index.

Output ONLY a one-line summary (≤120 chars) capturing the substantive durable facts in the document — preferences, biographical details, plans, decisions, opinions, ongoing situations. Skip greetings, meta-commentary, and chitchat. Be specific, not generic.

Good: "User commutes 45 min each way to work in Boston; prefers Tesla over BMW."
Bad: "User had a conversation about cars and their commute."`;

const DENSIFY_MAX_TOKENS = 256;
const DENSIFY_TEMPERATURE = 0.2;

/** Default hard deadline for a single densify LLM round-trip (ms). */
export const DEFAULT_MAP_DENSIFY_TIMEOUT_MS = 30_000;

/**
 * Input to a single densification call. We pass the doc's FACTS (the bullet
 * bodies under `## Facts`), not the raw markdown, so the densifier sees the
 * substantive content and nothing else. `docId` is `<category>/<slug>` — used
 * for cache keying and degradation logging, never embedded in the prompt.
 */
export interface MapDensifyInput {
  docId: string;
  category: DocCategory;
  facts: string[];
  /** The doc's current frontmatter summary (the fallback if densify fails). */
  fallbackSummary: string;
}

/**
 * Densifier callback. The plugin wires this to a bounded host-LLM round-trip
 * (same `llm:call:*` gating as the Observer). Returns a ~120-char fact
 * one-liner. `map.ts` stays bus-agnostic — it knows nothing about the LLM
 * transport — so it is fully test-driveable with a stub densifier.
 */
export type MapDensifier = (input: MapDensifyInput) => Promise<string>;

export interface RegenerateMapInput {
  workspaceRoot: string;
  now: Date;
  /**
   * Optional host-LLM densifier. Omit it (CI, no keys, provider down) to get a
   * map built from raw frontmatter summaries. Present ⇒ incremental densify.
   */
  densify?: MapDensifier | undefined;
  /** Per-summary char cap. Default {@link MAP_SUMMARY_MAX_CHARS}. */
  summaryMaxChars?: number | undefined;
  /** Optional logger for degradation audit lines. Defaults to no-op. */
  logger?: { warn(event: string, fields: Record<string, unknown>): void } | undefined;
}

interface MapCacheEntry {
  /** Hash of the doc's source facts; a mismatch means the doc changed. */
  hash: string;
  /** The cached densified one-liner. */
  summary: string;
}
type MapCache = Record<string, MapCacheEntry>;

/**
 * Regenerate `system/map.md` from the current docs tree. Returns the
 * workspace-relative path written.
 */
export async function regenerateMap(
  input: RegenerateMapInput,
): Promise<{ path: string }> {
  const summaryMax = input.summaryMaxChars ?? MAP_SUMMARY_MAX_CHARS;
  const log = input.logger;

  const docs = await listDocs({ workspaceRoot: input.workspaceRoot });
  const cache = await loadCache(input.workspaceRoot);
  const nextCache: MapCache = {};

  // category → sorted list of { slug, summary }
  const byCategory = new Map<DocCategory, Array<{ slug: string; summary: string }>>();

  for (const doc of docs) {
    const docId = doc.frontmatter.id;
    const category = doc.frontmatter.type.replace(/^docs\//, '') as DocCategory;
    const facts = extractFacts(doc.body);
    const fallback = truncate(doc.frontmatter.summary, summaryMax);

    const summary = await densifyOne({
      docId,
      category,
      facts,
      fallbackSummary: fallback,
      densify: input.densify,
      cache,
      nextCache,
      summaryMax,
      log,
    });

    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push({ slug: slugOf(doc), summary });
  }

  for (const arr of byCategory.values()) arr.sort((a, b) => a.slug.localeCompare(b.slug));

  const body = renderBody(byCategory);
  const fm: MemoryFrontmatter = {
    id: 'map',
    type: 'system/map',
    created: input.now.toISOString(),
    confidence: 1.0,
    pinned: true,
    summary:
      'Hierarchical index of the agent\'s memory — one densified line per doc, regenerated each consolidation pass.',
    event_time: input.now.toISOString(),
    recorded_at: input.now.toISOString(),
  };

  const rel = mapFile();
  const abs = join(input.workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');

  // Persist the cache so the next pass can skip unchanged docs. Only entries
  // for docs that still exist are written (a deleted doc drops out — no
  // unbounded growth). Best-effort: a cache write failure must not fail the
  // pass (the map itself is already on disk).
  try {
    await writeCache(input.workspaceRoot, nextCache);
  } catch (err) {
    log?.warn('memory_strata_map_cache_write_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }

  return { path: rel };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function densifyOne(args: {
  docId: string;
  category: DocCategory;
  facts: string[];
  fallbackSummary: string;
  densify: MapDensifier | undefined;
  cache: MapCache;
  nextCache: MapCache;
  summaryMax: number;
  log: RegenerateMapInput['logger'];
}): Promise<string> {
  const { docId, category, facts, fallbackSummary, densify, cache, nextCache, summaryMax, log } = args;

  // No densifier configured (CI / no keys / provider down): raw summary.
  // Do NOT write a cache entry — a later keyed pass must still densify, and we
  // must not poison the cache with the un-densified fallback.
  if (densify === undefined) {
    return fallbackSummary;
  }

  const hash = hashFacts(facts);
  const cached = cache[docId];
  if (cached !== undefined && cached.hash === hash) {
    // Unchanged doc — serve the densified one-liner from cache, free.
    nextCache[docId] = cached;
    return cached.summary;
  }

  // Defence in depth: docs are already sensitive-gated at observation time, but
  // the map must not be a wider trust boundary than the doc store. Drop any
  // fact that the gate would reject before it reaches the densifier; if every
  // fact is dropped, fall back to the (already-gated) summary without calling
  // the LLM at all.
  const safeFacts = facts.filter((f) => filterSensitive(f).kept);
  if (safeFacts.length === 0) {
    return fallbackSummary;
  }

  let summary: string;
  try {
    const raw = await densify({ docId, category, facts: safeFacts, fallbackSummary });
    summary = cleanSummary(raw, summaryMax);
    if (summary.length === 0) summary = fallbackSummary;
  } catch (err) {
    // A single doc's densification failure degrades to its raw summary; the
    // pass continues. Do NOT cache the fallback (so the next pass retries).
    log?.warn('memory_strata_map_densify_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
      docId,
    });
    return fallbackSummary;
  }

  nextCache[docId] = { hash, summary };
  return summary;
}

/** Extract bullet bodies under the `## Facts` heading. Same shape as the consolidator. */
function extractFacts(body: string): string[] {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## Facts');
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ')) out.push(l.slice(2).trim());
  }
  return out;
}

/** `<category>/<slug>` → the trailing slug for display + sorting. */
function slugOf(doc: DocFile): string {
  const id = doc.frontmatter.id;
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

function renderBody(
  byCategory: Map<DocCategory, Array<{ slug: string; summary: string }>>,
): string {
  const lines: string[] = ['# Memory Map', ''];
  const cats = [...byCategory.keys()].sort();
  if (cats.length === 0) {
    lines.push('_No memory yet._', '');
    return lines.join('\n');
  }
  for (const cat of cats) {
    lines.push(`## ${cat}/`);
    for (const { slug, summary } of byCategory.get(cat)!) {
      lines.push(`- ${slug}: ${summary}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function hashFacts(facts: string[]): string {
  const h = createHash('sha256');
  // Facts are already in stable doc order (append order); hash them verbatim
  // with a separator that can't appear inside a single bullet line.
  h.update(facts.join('\n \n'));
  return h.digest('hex').slice(0, 16);
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + '…';
}

/**
 * Normalize a densifier's raw output to a single ≤cap line. Mirrors the bench
 * `cleanSummary`: strip code fences, a leading "Summary:" prefix, collapse to
 * the first non-empty line, and cap length.
 */
export function cleanSummary(raw: string, maxChars: number): string {
  let s = raw.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  s = s.replace(/^summary\s*[:\-]\s*/i, '');
  const firstLine = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  s = firstLine.trim();
  if (s.length > maxChars) s = s.slice(0, maxChars - 1) + '…';
  return s;
}

async function loadCache(workspaceRoot: string): Promise<MapCache> {
  const abs = join(workspaceRoot, mapCacheFile());
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // A corrupt/unreadable cache is non-fatal — treat as empty (we'll
    // re-densify and rewrite it). Don't throw out of the pass.
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: MapCache = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        v !== null &&
        typeof v === 'object' &&
        typeof (v as MapCacheEntry).hash === 'string' &&
        typeof (v as MapCacheEntry).summary === 'string'
      ) {
        out[k] = { hash: (v as MapCacheEntry).hash, summary: (v as MapCacheEntry).summary };
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeCache(workspaceRoot: string, cache: MapCache): Promise<void> {
  const abs = join(workspaceRoot, mapCacheFile());
  await mkdir(dirname(abs), { recursive: true });
  // Stable key order so the sidecar is itself deterministic (helps git-tier
  // diffs and avoids spurious churn on the on-disk cache).
  const ordered: MapCache = {};
  for (const k of Object.keys(cache).sort()) ordered[k] = cache[k]!;
  await writeFile(abs, JSON.stringify(ordered, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Host-LLM densifier factory (bus-agnostic — takes a plain llmCall fn)
// ---------------------------------------------------------------------------

export type LlmCallFn = (input: LlmCallInput) => Promise<LlmCallOutput>;

/**
 * Build a {@link MapDensifier} backed by the host LLM. The plugin wires
 * `llmCall` to `bus.call(llmCallHook, ctx, ...)` (the SAME gating as the
 * Observer) and passes the agent's resolved model. Bus-agnostic so `map.ts`
 * has no `@ax/core` HookBus dependency in its core path and stays
 * test-driveable with a stub `llmCall`.
 *
 * Each call is bounded by `timeoutMs` (per the Observer's I6 posture): a slow
 * round-trip is abandoned and surfaces as a thrown {@link TimeoutError}, which
 * `regenerateMap` catches per-doc and degrades to the raw summary. We send the
 * doc's FACTS only (never the raw markdown / frontmatter), so the densifier
 * sees substantive content and nothing that could carry a stray instruction in
 * a heading or YAML field.
 */
export function makeLlmDensifier(opts: {
  llmCall: LlmCallFn;
  model: string;
  timeoutMs?: number;
}): MapDensifier {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MAP_DENSIFY_TIMEOUT_MS;
  return async (input: MapDensifyInput): Promise<string> => {
    const user = `Document facts:\n${input.facts.map((f) => `- ${f}`).join('\n')}`;
    // raceTimeout throws a TimeoutError on a slow call; regenerateMap's per-doc
    // catch degrades this one doc to its raw summary (and does NOT cache the
    // fallback, so the next pass retries). Any other LLM error propagates the
    // same way.
    const out = await raceTimeout(
      opts.llmCall({
        model: opts.model,
        maxTokens: DENSIFY_MAX_TOKENS,
        system: DENSIFY_SYSTEM,
        messages: [{ role: 'user', content: user }],
        temperature: DENSIFY_TEMPERATURE,
      }),
      timeoutMs,
    );
    // Normalize here so the LLM-backed densifier always returns a clean ≤cap
    // one-liner (strip fences / "Summary:" prefix / extra lines). regenerateMap
    // also cleans defensively, so this is idempotent — but a self-contained
    // densifier is the right contract for any MapDensifier impl.
    return cleanSummary(out.text, MAP_SUMMARY_MAX_CHARS);
  };
}

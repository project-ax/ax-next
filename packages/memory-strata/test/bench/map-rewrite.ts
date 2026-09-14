import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrchestratorClient } from './orchestrator.js';
import type { BenchCorpus, MarkdownDoc } from './types.js';
import type { ModelUsage } from './meter.js';

export interface MapRewriteCacheEntry {
  hash: string;
  summary: string;
}

export type MapRewriteCache = Record<string, MapRewriteCacheEntry>;

export interface MapRewriteOptions {
  corpus: BenchCorpus;
  /**
   * Client that rewrites each doc's summary. Named for a model until
   * 2026-09-11 — the name outlived `x-ai/grok-4.1-fast` by months, which is
   * how a dead id stayed invisible in the call site.
   */
  rewriteClient: OrchestratorClient;
  cachePath: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * Called with each call's token usage so the caller can meter it.
   *
   * This path makes ONE paid call per corpus document — 19,195 of them for
   * longmemeval-s, around $7 — and reported nothing. Every other paid path in
   * this bench prints its spend, which is precisely why the omission survived:
   * the run ends with "Done. 19195 summaries in cache" and reads like a
   * success with no price on it. The handoff that tallied this track's cost had
   * to estimate this line rather than read it.
   */
  onUsage?: (usage: ModelUsage) => void;
}

/**
 * Hard cut applied to a stored map summary — the line the planner reads.
 *
 * The planner selects documents by matching a question against these lines, so
 * whatever a line cannot fit is not merely abbreviated, it is unreachable.
 *
 * Measured 2026-09-14 against the live 19,195-entry caches: at 120 the
 * Grok-authored map had 59.3% of lines cut off mid-word and the GLM-authored
 * one **90.0%**. p50 and p95 both sit exactly at the cap, the signature of a
 * budget binding on most of the distribution rather than clipping an outlier.
 *
 * Deliberately SEPARATE from {@link MAP_SUMMARY_PROMPT_BUDGET}. The first cut
 * of this change fused them, on the assumption that a model told "≤120" would
 * aim at 120 and a bigger cut would buy nothing without also asking for more.
 * `bench:diag-map-truncation --probe 60` disproved it: asked for ≤120, GLM
 * writes p50 **157**, p95 **243**, max **346** — over its own budget on 88% of
 * documents, with **28.1% of the characters it produces discarded at the cut**.
 * So raising the cut alone is a real intervention, and the clean one: it keeps
 * the summary the model already intended to write and stops mutilating it,
 * without also changing how much it writes. Fusing the two knobs would have
 * confounded "stop cutting lines" with "write denser lines" in one measurement.
 *
 * Unlike a read-side cap this cannot be raised in place: summaries are STORED
 * cut, so changing it requires regenerating the map cache (one paid call per
 * corpus document, ~$7 for longmemeval-s). `AX_BENCH_MAP_SUMMARY_CHARS`
 * overrides it; `bench:diag-map-truncation` measures what it is throwing away.
 */
export const MAP_SUMMARY_MAX_CHARS = Number(
  process.env.AX_BENCH_MAP_SUMMARY_CHARS ?? 120,
);

/**
 * Length the rewrite PROMPT asks for, which the model treats as a suggestion.
 *
 * Probed 2026-09-14 (n=60/budget): asked ≤120 it returns p50 157; asked ≤240,
 * p50 245; asked ≤400, p50 279 and only 12% exceed. It expands to fill whatever
 * it is given, so this knob controls map DENSITY — a different question from
 * whether the stored line gets cut, which is {@link MAP_SUMMARY_MAX_CHARS}.
 */
export const MAP_SUMMARY_PROMPT_BUDGET = Number(
  process.env.AX_BENCH_MAP_SUMMARY_BUDGET ?? 120,
);

export function rewriteSystemPrompt(maxChars: number = MAP_SUMMARY_PROMPT_BUDGET): string {
  return `You are summarizing a single conversation session for an agent's structured memory index.

Output ONLY a one-line summary (≤${maxChars} chars) capturing the substantive facts the USER mentioned about themselves — preferences, biographical details, plans, decisions, opinions, ongoing situations. Skip greetings, assistant responses, and chitchat. Be specific, not generic.

Good: "User commutes 45 min each way to work in Boston; prefers Tesla over BMW."
Bad: "User had a conversation about cars and their commute."`;
}

export function hashDocBody(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export function loadMapRewriteCache(cachePath: string): MapRewriteCache {
  if (!existsSync(cachePath)) return {};
  try {
    const raw = readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: MapRewriteCache = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        v &&
        typeof v === 'object' &&
        typeof (v as MapRewriteCacheEntry).hash === 'string' &&
        typeof (v as MapRewriteCacheEntry).summary === 'string'
      ) {
        out[k] = {
          hash: (v as MapRewriteCacheEntry).hash,
          summary: (v as MapRewriteCacheEntry).summary,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeMapRewriteCache(cachePath: string, cache: MapRewriteCache): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

export function cacheToOverrideMap(cache: MapRewriteCache): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, entry] of Object.entries(cache)) {
    out.set(path, entry.summary);
  }
  return out;
}

export async function withConcurrency<T, R>(
  items: ReadonlyArray<T>,
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workerCount = Math.max(1, Math.min(n, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

interface RewriteTask {
  doc: MarkdownDoc;
  hash: string;
}

async function rewriteOne(
  client: OrchestratorClient,
  doc: MarkdownDoc,
  onUsage?: (usage: ModelUsage) => void,
): Promise<string> {
  const user = `Conversation:\n${doc.body}`;
  const resp = await client.complete({ system: rewriteSystemPrompt(), user });
  // Report usage BEFORE cleanSummary, so a summary this rejects is still paid
  // for in the total. Spend is what left the account, not what we kept.
  onUsage?.(resp.usage);
  return cleanSummary(resp.text);
}

export function cleanSummary(raw: string, maxChars: number = MAP_SUMMARY_MAX_CHARS): string {
  // Strip code fences, leading/trailing whitespace, and collapse to one line.
  let s = raw.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  // Drop a leading "Summary:" prefix if the model added one.
  s = s.replace(/^summary\s*[:\-]\s*/i, '');
  // Take only the first non-empty line.
  const firstLine = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  s = firstLine.trim();
  if (s.length > maxChars) {
    s = s.slice(0, maxChars - 1) + '…';
  }
  return s;
}

export async function rewriteMapSummaries(
  opts: MapRewriteOptions,
): Promise<Map<string, string>> {
  const concurrency = opts.concurrency ?? 10;
  const cache: MapRewriteCache = loadMapRewriteCache(opts.cachePath);

  const todo: RewriteTask[] = [];
  for (const doc of opts.corpus.memoryTree.values()) {
    const hash = hashDocBody(doc.body);
    const existing = cache[doc.path];
    if (existing && existing.hash === hash) continue;
    todo.push({ doc, hash });
  }

  const total = opts.corpus.memoryTree.size;
  let done = total - todo.length;
  if (opts.onProgress) opts.onProgress(done, total);

  // Persist cache periodically (every ~50 completions) so a crash doesn't lose
  // a multi-hour run.
  let sinceFlush = 0;
  const FLUSH_EVERY = 50;

  await withConcurrency(todo, concurrency, async (task) => {
    const summary = await rewriteOne(opts.rewriteClient, task.doc, opts.onUsage);
    cache[task.doc.path] = { hash: task.hash, summary };
    done++;
    sinceFlush++;
    if (opts.onProgress) opts.onProgress(done, total);
    if (sinceFlush >= FLUSH_EVERY) {
      sinceFlush = 0;
      writeMapRewriteCache(opts.cachePath, cache);
    }
  });

  writeMapRewriteCache(opts.cachePath, cache);
  return cacheToOverrideMap(cache);
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrchestratorClient } from './orchestrator.js';
import type { BenchCorpus, MarkdownDoc } from './types.js';

export interface MapRewriteCacheEntry {
  hash: string;
  summary: string;
}

export type MapRewriteCache = Record<string, MapRewriteCacheEntry>;

export interface MapRewriteOptions {
  corpus: BenchCorpus;
  grokClient: OrchestratorClient;
  cachePath: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

const REWRITE_SYSTEM = `You are summarizing a single conversation session for an agent's structured memory index.

Output ONLY a one-line summary (≤120 chars) capturing the substantive facts the USER mentioned about themselves — preferences, biographical details, plans, decisions, opinions, ongoing situations. Skip greetings, assistant responses, and chitchat. Be specific, not generic.

Good: "User commutes 45 min each way to work in Boston; prefers Tesla over BMW."
Bad: "User had a conversation about cars and their commute."`;

const REWRITE_MAX_CHARS = 120;

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
): Promise<string> {
  const user = `Conversation:\n${doc.body}`;
  const resp = await client.complete({ system: REWRITE_SYSTEM, user });
  return cleanSummary(resp.text);
}

export function cleanSummary(raw: string): string {
  // Strip code fences, leading/trailing whitespace, and collapse to one line.
  let s = raw.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  // Drop a leading "Summary:" prefix if the model added one.
  s = s.replace(/^summary\s*[:\-]\s*/i, '');
  // Take only the first non-empty line.
  const firstLine = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  s = firstLine.trim();
  if (s.length > REWRITE_MAX_CHARS) {
    s = s.slice(0, REWRITE_MAX_CHARS - 1) + '…';
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
    const summary = await rewriteOne(opts.grokClient, task.doc);
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

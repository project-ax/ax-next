import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderMapForOrchestrator, type MapEntry } from '../../src/orchestrator.js';
import { join } from 'node:path';
import type { BenchCorpus } from './types.js';

interface MapOptions {
  cacheDir: string;
  summaryMaxChars?: number;
  subsetPaths?: ReadonlyArray<string>;
  /**
   * Optional map from doc.path to a pre-computed (e.g. LLM-rewritten) summary.
   * When present, this entry is used in place of `doc.summary`. Falls back to
   * `doc.summary` for any path not in the map. The override set is folded into
   * the cache hash so a corpus rendered with/without overrides does not
   * collide.
   */
  overrideSummaries?: ReadonlyMap<string, string>;
}

const DEFAULT_SUMMARY_MAX = 120;

export async function generateMap(corpus: BenchCorpus, opts: MapOptions): Promise<string> {
  mkdirSync(opts.cacheDir, { recursive: true });
  const summaryMax = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX;

  const hash = computeCorpusHash(corpus, opts.subsetPaths, opts.overrideSummaries);
  const cachePath = join(opts.cacheDir, `${corpus.name}-${hash}.md`);
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');

  const paths = opts.subsetPaths ?? [...corpus.memoryTree.keys()];
  const entries: MapEntry[] = [];
  for (const p of paths) {
    const doc = corpus.memoryTree.get(p);
    if (!doc) continue;
    const summary = opts.overrideSummaries?.get(doc.path) ?? doc.summary;
    entries.push({
      docId: doc.path,
      category: doc.category,
      slug: doc.slug,
      summary: truncate(summary, summaryMax),
    });
  }
  entries.sort((a, b) => a.docId.localeCompare(b.docId));

  // Rendered by the RUNTIME's own prompt renderer, not a bench lookalike.
  //
  // The two had drifted, silently and expensively. The runtime STORES the map
  // as `## <category>/` + `- <slug>: ...` but never shows the planner that
  // form — `renderMapForOrchestrator` re-renders it flat and fully qualified,
  // which is the shape `<load doc="...">` is matched against. The bench, whose
  // map string IS the prompt, imitated the storage form instead. A planner that
  // copied the bare slug back produced an op resolving to nothing, which is
  // dropped in silence and covered by the BM25 fallback — so the arm still
  // returned a number, it just measured which model guesses the missing
  // prefix. Measured 2026-09-11 at n=40: haiku lost 80% of its plans to this
  // and its recall@5 went 40.0% -> 92.5% once the prompt was faithful.
  const out = `# Memory Map\n\n${renderMapForOrchestrator(entries)}\n`;
  writeFileSync(cachePath, out);
  return out;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function computeCorpusHash(
  corpus: BenchCorpus,
  subsetPaths: ReadonlyArray<string> | undefined,
  overrideSummaries: ReadonlyMap<string, string> | undefined,
): string {
  const h = createHash('sha256');
  const paths = subsetPaths
    ? [...subsetPaths].sort()
    : [...corpus.memoryTree.keys()].sort();
  h.update(corpus.name);
  for (const p of paths) {
    const d = corpus.memoryTree.get(p);
    if (!d) continue;
    h.update(p);
    h.update(d.summary);
  }
  if (overrideSummaries && overrideSummaries.size > 0) {
    h.update('|overrides|');
    const keys = [...overrideSummaries.keys()].sort();
    for (const k of keys) {
      h.update(k);
      h.update('=');
      h.update(overrideSummaries.get(k) ?? '');
    }
  }
  return h.digest('hex').slice(0, 16);
}

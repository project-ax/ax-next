import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const byCategory = new Map<string, Array<{ slug: string; summary: string }>>();
  for (const p of paths) {
    const doc = corpus.memoryTree.get(p);
    if (!doc) continue;
    if (!byCategory.has(doc.category)) byCategory.set(doc.category, []);
    const summary = opts.overrideSummaries?.get(doc.path) ?? doc.summary;
    byCategory.get(doc.category)!.push({
      slug: doc.slug,
      summary: truncate(summary, summaryMax),
    });
  }
  for (const arr of byCategory.values()) arr.sort((a, b) => a.slug.localeCompare(b.slug));

  const lines: string[] = ['# Memory Map', ''];
  for (const cat of [...byCategory.keys()].sort()) {
    lines.push(`## ${cat}/`);
    for (const { slug, summary } of byCategory.get(cat)!) {
      lines.push(`- ${slug}: ${summary}`);
    }
    lines.push('');
  }
  const out = lines.join('\n');
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

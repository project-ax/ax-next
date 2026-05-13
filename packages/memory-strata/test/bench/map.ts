import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchCorpus } from './types.js';

interface MapOptions {
  cacheDir: string;
  summaryMaxChars?: number;
}

const DEFAULT_SUMMARY_MAX = 120;

export async function generateMap(corpus: BenchCorpus, opts: MapOptions): Promise<string> {
  mkdirSync(opts.cacheDir, { recursive: true });
  const summaryMax = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX;

  const hash = computeCorpusHash(corpus);
  const cachePath = join(opts.cacheDir, `${corpus.name}-${hash}.md`);
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');

  const byCategory = new Map<string, Array<{ slug: string; summary: string }>>();
  for (const doc of corpus.memoryTree.values()) {
    if (!byCategory.has(doc.category)) byCategory.set(doc.category, []);
    byCategory.get(doc.category)!.push({
      slug: doc.slug,
      summary: truncate(doc.summary, summaryMax),
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

function computeCorpusHash(corpus: BenchCorpus): string {
  const h = createHash('sha256');
  const paths = [...corpus.memoryTree.keys()].sort();
  h.update(corpus.name);
  for (const p of paths) {
    const d = corpus.memoryTree.get(p)!;
    h.update(p);
    h.update(d.summary);
  }
  return h.digest('hex').slice(0, 16);
}

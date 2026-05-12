import type { MarkdownDoc, BenchCorpus } from '../types.js';

export function makeDoc(input: {
  category: MarkdownDoc['category'];
  slug: string;
  summary: string;
  body: string;
  factType?: string;
}): MarkdownDoc {
  const path = `${input.category}/${input.slug}`;
  return {
    path,
    category: input.category,
    slug: input.slug,
    summary: input.summary,
    factType: input.factType ?? 'episode',
    headers: extractHeaders(input.body),
    body: input.body,
  };
}

function extractHeaders(body: string): string {
  const lines = body.split('\n').filter((l) => /^#{1,6}\s+/.test(l));
  return lines.join('\n');
}

export function emptyCorpus(name: BenchCorpus['name']): BenchCorpus {
  return { name, memoryTree: new Map(), questions: [] };
}

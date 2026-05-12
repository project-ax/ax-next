import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchCorpus, MarkdownDoc, BenchQuestion } from '../types.js';

export interface InternalCorpusFile {
  docs: MarkdownDoc[];
  questions: BenchQuestion[];
}

export function loadInternalCorpusFromJson(json: string): BenchCorpus {
  const parsed = JSON.parse(json) as InternalCorpusFile;
  const memoryTree = new Map<string, MarkdownDoc>(parsed.docs.map((d) => [d.path, d]));
  return { name: 'internal', memoryTree, questions: parsed.questions };
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const THIS_DIR = dirname(fileURLToPath(import.meta.url!));
export const INTERNAL_CORPUS_PATH = join(THIS_DIR, '..', 'internal-corpus.json');

export function loadInternalCorpus(): BenchCorpus {
  if (!existsSync(INTERNAL_CORPUS_PATH)) {
    throw new Error(
      `Internal corpus not found at ${INTERNAL_CORPUS_PATH}. ` +
        `Run "pnpm --filter @ax/memory-strata bench --regen-internal" to generate it.`,
    );
  }
  return loadInternalCorpusFromJson(readFileSync(INTERNAL_CORPUS_PATH, 'utf8'));
}

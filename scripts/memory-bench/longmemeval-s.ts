// Moved from the deleted `@ax/memory-strata` package's bench harness (TASK-608
// deleted packages/memory-strata; this is a trimmed copy of the old
// `packages/memory-strata/test/bench/corpora/longmemeval-s.ts`, keeping only the
// RAW-sample loader `scripts/memory-product-e2e.mjs` and
// `scripts/memory-lifetime-soak.mjs` actually use). Dropped:
// `transformLongMemEvalSample`/`loadLongMemEvalS` (the bench A-E config-driver
// path, which collapsed sessions into pre-digested `episodes/<id>` markdown docs
// via the deleted plugin's `MarkdownDoc`/`BenchQuestion`/`BenchCorpus` types and
// `makeDoc` helper) and `isUnanswerable` (both harnesses already inline the
// `_abs`-suffix check themselves).

import { BenchCache } from './cache.js';

export interface LongMemEvalTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LongMemEvalSample {
  question_id: string;
  question_type?: string;
  question: string;
  question_date?: string;
  answer: string;
  answer_session_ids?: string[];
  haystack_dates?: string[];
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalTurn[][];
}

const DATASET_NAME = 'longmemeval-s';
const HF_DOWNLOAD_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';
const CACHE_FILE = 'longmemeval_s_cleaned.json';

/**
 * Read the cached LongMemEval-S JSON, downloading it from HuggingFace on a cache
 * miss.
 */
async function fetchOrReadCached(cache: BenchCache): Promise<Buffer> {
  const hit = await cache.readIfHit(DATASET_NAME, CACHE_FILE);
  if (hit) return hit;
  const res = await fetch(HF_DOWNLOAD_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch LongMemEval-S from ${HF_DOWNLOAD_URL}: ${res.status}. ` +
        `Cache miss with no network. Manually download into ~/.cache/ax-memory-bench/${DATASET_NAME}/${CACHE_FILE}.`,
    );
  }
  const raw = Buffer.from(await res.arrayBuffer());
  await cache.write(DATASET_NAME, CACHE_FILE, raw);
  return raw;
}

/**
 * Load the RAW LongMemEval-S samples — haystack sessions intact — for the
 * end-to-end harness (TASK-189).
 */
export async function loadLongMemEvalSSamples(
  cache: BenchCache,
): Promise<LongMemEvalSample[]> {
  const raw = await fetchOrReadCached(cache);
  return JSON.parse(raw.toString()) as LongMemEvalSample[];
}

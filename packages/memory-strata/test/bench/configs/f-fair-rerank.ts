// Config F — the FAIR reranker (TASK-192).
//
// The prior reranker test (config B, hosted `zerank-2`) LOST to BM25-only by 2.4pp
// at ~6× the latency — but it ran in a deliberately weak setup. This config gives the
// reranker a fair shake by fixing all four of B's unfairness levers at once:
//
//   1. Wider BM25 candidate pool. B reranked only `topK*3` candidates; F reranks a
//      wide pool (`bm25CandidateCount`, default 50) so the cross-encoder has room to
//      promote a doc BM25 ranked deep.
//   2. Full document bodies. B truncated every body to 2000 chars before reranking;
//      F sends the FULL body (the cross-encoder's whole value is reading the text).
//   3. Query expansion before retrieval. B reranked the raw query's hits with no
//      expansion; F runs a first-pass BM25, harvests PRF terms + query entities
//      (see `query-expansion.ts`), and re-queries with the expanded query.
//   4. A LOCAL cross-encoder (mxbai-rerank-large-v1, ~435M) instead of the hosted
//      zerank-2 — injected via the same `RerankClient` interface config B uses, so
//      this driver is model-agnostic and CI can stub it.
//
// See SmartSearch (arXiv 2603.15599): a local cross-encoder + query expansion over
// full bodies reaches 88.4% LongMemEval-S. This config exists to test whether that
// reproduces here and beats BM25-only by >=5pp. Measurement spike ONLY — nothing
// here is wired into the runtime.

import { createConfigA } from './a-bm25.js';
import { expandQuery, type ExpandQueryOptions } from '../query-expansion.js';
import type { RerankClient } from './b-rerank.js';
import type {
  BenchCorpus,
  BenchQuestion,
  ConfigDriver,
  RetrievalResult,
  RetrievedDoc,
} from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface ConfigFOptions extends ConfigFactoryOptions {
  /** The local cross-encoder rerank client (stubbed in CI). */
  rerankClient: RerankClient;
  /** Wide BM25 candidate pool fed to the reranker (default 50). */
  bm25CandidateCount?: number;
  /** Query-expansion tuning (PRF term count, stopwords, …). */
  expandOptions?: ExpandQueryOptions;
  /** Test hook: observe the expanded second-pass query string. */
  onSecondPassQuery?: (query: string) => void;
}

const DEFAULT_CANDIDATE_COUNT = 50;
/** How many first-pass hit bodies feed the PRF expansion. */
const PRF_FEEDBACK_DEPTH = 5;

export function createConfigF(opts: ConfigFOptions): ConfigDriver {
  const inner = createConfigA(opts);
  let corpusRef: BenchCorpus | null = null;
  const candidateCount = opts.bm25CandidateCount ?? DEFAULT_CANDIDATE_COUNT;

  return {
    name: 'f-fair-rerank',
    async build(corpus: BenchCorpus) {
      corpusRef = corpus;
      await inner.build(corpus);
    },
    async teardown() {
      corpusRef = null;
      await inner.teardown();
    },
    async retrieve(
      question: BenchQuestion,
      topK: number,
      signal: AbortSignal,
    ): Promise<RetrievalResult> {
      if (!corpusRef) throw new Error('Config F: build() not called');
      const corpus = corpusRef;

      // 1. First-pass BM25 over the wide pool with the RAW query.
      const firstPass = await inner.retrieve(question, candidateCount, signal);

      // 2. Query expansion: PRF terms from the first-pass hit bodies + query entities.
      const prfHits = firstPass.retrievedDocs
        .slice(0, PRF_FEEDBACK_DEPTH)
        .map((d) => ({ body: corpus.memoryTree.get(d.path)?.body ?? d.summary }));
      const expanded = expandQuery(question.text, prfHits, opts.expandOptions ?? {});
      opts.onSecondPassQuery?.(expanded);

      // 3. Second-pass BM25 over the wide pool with the EXPANDED query (PRF re-query).
      const secondPass = await inner.retrieve(
        { ...question, text: expanded },
        candidateCount,
        signal,
      );

      // Union the two passes (expansion can surface docs the raw query missed),
      // preserving the second pass's ordering first, then any first-pass-only docs.
      const candidates: RetrievedDoc[] = [];
      const seen = new Set<string>();
      for (const d of [...secondPass.retrievedDocs, ...firstPass.retrievedDocs]) {
        if (seen.has(d.path)) continue;
        seen.add(d.path);
        candidates.push(d);
      }

      // 4. Rerank the FULL bodies (no truncation) with the local cross-encoder.
      const docs = candidates.map((d) => ({
        docId: d.path,
        text: corpus.memoryTree.get(d.path)?.body ?? d.summary,
      }));
      const t0 = Date.now();
      const reranked = docs.length > 0
        ? await opts.rerankClient.rerank(expanded, docs)
        : { reranked: [], tokens: 0 };
      const rerankMs = Date.now() - t0;

      const scoreMap = new Map(reranked.reranked.map((r) => [r.docId, r.score]));
      const retrieved: RetrievedDoc[] = candidates
        .map((d) => ({ ...d, score: scoreMap.get(d.path) ?? -Infinity }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      return {
        retrievedDocs: retrieved,
        latencyMs: firstPass.latencyMs + secondPass.latencyMs + rerankMs,
        embeddingTokens: 0,
        rerankTokens: reranked.tokens,
        rerankMs,
      };
    },
  };
}

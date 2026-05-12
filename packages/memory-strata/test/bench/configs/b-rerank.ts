import { createConfigA } from './a-bm25.js';
import { ZeroEntropy } from 'zeroentropy';
import type {
  BenchCorpus,
  BenchQuestion,
  ConfigDriver,
  RetrievalResult,
  RetrievedDoc,
} from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface RerankClient {
  rerank(
    query: string,
    docs: Array<{ docId: string; text: string }>,
  ): Promise<{
    reranked: Array<{ docId: string; score: number }>;
    tokens: number;
  }>;
}

export interface ConfigBOptions extends ConfigFactoryOptions {
  rerankClient: RerankClient;
  bm25CandidateCount?: number;
}

export function createConfigB(opts: ConfigBOptions): ConfigDriver {
  const inner = createConfigA(opts);
  let corpusRef: BenchCorpus | null = null;
  return {
    name: 'b-rerank',
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
      const candidateK = opts.bm25CandidateCount ?? topK * 3;
      const inner1 = await inner.retrieve(question, candidateK, signal);
      if (!corpusRef) throw new Error('Config B: build() not called');
      const docs = inner1.retrievedDocs.map((d) => ({
        docId: d.path,
        text: corpusRef!.memoryTree.get(d.path)?.summary ?? d.summary,
      }));
      const t0 = Date.now();
      const reranked = await opts.rerankClient.rerank(question.text, docs);
      const reorderMs = Date.now() - t0;
      const scoreMap = new Map(reranked.reranked.map((r) => [r.docId, r.score]));
      const retrieved: RetrievedDoc[] = inner1.retrievedDocs
        .map((d) => ({ ...d, score: scoreMap.get(d.path) ?? -Infinity }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return {
        retrievedDocs: retrieved,
        latencyMs: inner1.latencyMs + reorderMs,
        embeddingTokens: 0,
        rerankTokens: reranked.tokens,
      };
    },
  };
}

export function makeZeroEntropyRerankClient(apiKey: string, model = 'zerank-2'): RerankClient {
  // The zeroentropy@0.1.0-alpha.10 SDK shape isn't statically verified here;
  // this factory is exercised only by Task 3A.17's live-smoke and may need
  // adjustment when run against the real API.
  const z = new ZeroEntropy({ apiKey });
  return {
    async rerank(query, docs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await (z as any).models.rerank({
        model,
        query,
        documents: docs.map((d) => d.text),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (resp as any).results as Array<{ index: number; relevance_score: number }>;
      const reranked = items.map((it) => ({
        docId: docs[it.index]!.docId,
        score: it.relevance_score,
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokens = (resp as any).usage?.total_tokens ?? 0;
      return { reranked, tokens };
    },
  };
}

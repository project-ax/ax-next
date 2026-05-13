import { createConfigA } from './a-bm25.js';
import { ZeroEntropy } from 'zeroentropy';
import { withRetry } from '../retry.js';
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

const RERANK_MAX_BODY_CHARS = 2000;

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
      const docs = inner1.retrievedDocs.map((d) => {
        const doc = corpusRef!.memoryTree.get(d.path);
        const body = doc ? doc.body : d.summary;
        return {
          docId: d.path,
          text: body.length > RERANK_MAX_BODY_CHARS ? body.slice(0, RERANK_MAX_BODY_CHARS) : body,
        };
      });
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
  const z = new ZeroEntropy({ apiKey });
  return {
    async rerank(query, docs) {
      return withRetry(
        async () => {
          const resp = await z.models.rerank({
            model,
            query,
            documents: docs.map((d) => d.text),
          });
          const reranked = resp.results.map((it) => ({
            docId: docs[it.index]!.docId,
            score: it.relevance_score,
          }));
          return { reranked, tokens: resp.total_tokens };
        },
        { attempts: 4, baseDelayMs: 2000, label: 'zeroentropy-rerank' },
      );
    },
  };
}

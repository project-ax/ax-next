import { createConfigA } from './a-bm25.js';
import { generateMap } from '../map.js';
import { runOrchestrator, runOps } from '../orchestrator.js';
import type { OrchestratorClient } from '../orchestrator.js';
import type {
  BenchCorpus,
  BenchQuestion,
  ConfigDriver,
  RetrievalResult,
} from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface ConfigDOptions extends ConfigFactoryOptions {
  orchestratorClient: OrchestratorClient;
  mapCacheDir: string;
}

export function createConfigD(opts: ConfigDOptions): ConfigDriver {
  const bm = createConfigA(opts);
  let corpusRef: BenchCorpus | null = null;

  return {
    name: 'd-map',
    async build(corpus: BenchCorpus) {
      corpusRef = corpus;
      await bm.build(corpus);
    },
    async teardown() {
      corpusRef = null;
      await bm.teardown();
    },
    async retrieve(
      question: BenchQuestion,
      topK: number,
      signal: AbortSignal,
    ): Promise<RetrievalResult> {
      if (!corpusRef) throw new Error('Config D: build() not called');
      const t0 = Date.now();
      const subsetPaths = question.metadata?.haystackPaths as
        | ReadonlyArray<string>
        | undefined;
      const mapForThisQ = await generateMap(corpusRef, {
        cacheDir: opts.mapCacheDir,
        ...(subsetPaths ? { subsetPaths } : {}),
      });
      const plan = await runOrchestrator(opts.orchestratorClient, mapForThisQ, question.text);
      const docs = await runOps(plan, {
        corpus: corpusRef,
        ftsSearch: async (query, k) => {
          const r = await bm.retrieve({ ...question, text: query }, k, signal);
          return r.retrievedDocs;
        },
        topK,
      });
      return {
        retrievedDocs: docs,
        latencyMs: Date.now() - t0,
        embeddingTokens: 0,
        rerankTokens: 0,
        orchestratorTokens: plan.usage,
        followupNeeded: plan.followupNeeded,
      };
    },
  };
}

import { createConfigA } from './a-bm25.js';
import { generateMap } from '../map.js';
import { runOrchestrator, runOps } from '../orchestrator.js';
import type { OrchestratorClient } from '../orchestrator.js';
import type {
  BenchCorpus,
  BenchQuestion,
  ConfigDriver,
  RetrievalResult,
  RetrievedDoc,
} from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface ConfigEOptions extends ConfigFactoryOptions {
  orchestratorClient: OrchestratorClient;
  mapCacheDir: string;
  /**
   * Optional pre-computed (e.g. LLM-rewritten) per-doc summaries. When passed,
   * `generateMap` uses these in place of `doc.summary` for the orchestrator's
   * memory map. See `map-rewrite.ts`.
   */
  mapSummaryOverrides?: ReadonlyMap<string, string>;
}

export function createConfigE(opts: ConfigEOptions): ConfigDriver {
  const bm = createConfigA(opts);
  let corpusRef: BenchCorpus | null = null;

  return {
    name: 'e-map-fts',
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
      if (!corpusRef) throw new Error('Config E: build() not called');
      const t0 = Date.now();
      const subsetPaths = question.metadata?.haystackPaths as
        | ReadonlyArray<string>
        | undefined;
      const mapForThisQ = await generateMap(corpusRef, {
        cacheDir: opts.mapCacheDir,
        ...(subsetPaths ? { subsetPaths } : {}),
        ...(opts.mapSummaryOverrides ? { overrideSummaries: opts.mapSummaryOverrides } : {}),
      });
      const plan = await runOrchestrator(opts.orchestratorClient, mapForThisQ, question.text);
      const primary = await runOps(plan, {
        corpus: corpusRef,
        ftsSearch: async (query, k) => {
          const r = await bm.retrieve({ ...question, text: query }, k, signal);
          return r.retrievedDocs;
        },
        topK,
      });

      const seen = new Set(primary.map((d) => d.path));
      const out: RetrievedDoc[] = [...primary];
      const shouldFallback = plan.followupNeeded || primary.length === 0;
      if (shouldFallback && out.length < topK) {
        const r = await bm.retrieve(question, topK, signal);
        for (const d of r.retrievedDocs) {
          if (seen.has(d.path)) continue;
          seen.add(d.path);
          out.push(d);
          if (out.length >= topK) break;
        }
      }

      return {
        retrievedDocs: out,
        latencyMs: Date.now() - t0,
        embeddingTokens: 0,
        rerankTokens: 0,
        orchestratorTokens: plan.usage,
        followupNeeded: plan.followupNeeded,
      };
    },
  };
}

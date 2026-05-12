import { HookBus, makeAgentContext } from '@ax/core';
import type { AgentContext } from '@ax/core';
import { createMemoryStrataIndexSqlitePlugin } from '@ax/memory-strata-index-sqlite';
import { join } from 'node:path';
import type {
  BenchCorpus,
  BenchQuestion,
  ConfigDriver,
  RetrievalResult,
  RetrievedDoc,
} from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

interface UpsertInput {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  factType: string;
  body: string;
  headers: string;
}

interface SearchInput {
  query: string;
  topK: number;
  categoryFilter?: string;
}

interface SearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  score: number;
}

interface SearchOutput {
  results: SearchResult[];
}

export function createConfigA(opts: ConfigFactoryOptions): ConfigDriver {
  let bus: HookBus | null = null;
  let plugin: ReturnType<typeof createMemoryStrataIndexSqlitePlugin> | null = null;
  const ctx: AgentContext = makeAgentContext({
    sessionId: 'bench',
    agentId: 'bench',
    userId: 'bench',
  });

  return {
    name: 'a-bm25',
    async build(corpus: BenchCorpus) {
      const dbPath = join(opts.tempDir, `${corpus.name}.db`);
      bus = new HookBus();
      plugin = createMemoryStrataIndexSqlitePlugin({ databasePath: dbPath });
      await plugin.init({ bus, config: {} });
      for (const doc of corpus.memoryTree.values()) {
        await bus.call<UpsertInput, void>('memory:index:upsert', ctx, {
          docId: doc.path,
          category: doc.category,
          slug: doc.slug,
          summary: doc.summary,
          factType: doc.factType,
          body: doc.body,
          headers: doc.headers,
        });
      }
    },
    async teardown() {
      if (plugin?.shutdown) await plugin.shutdown();
      bus = null;
      plugin = null;
    },
    async retrieve(
      question: BenchQuestion,
      topK: number,
      _signal: AbortSignal,
    ): Promise<RetrievalResult> {
      if (!bus) throw new Error('Config A: build() not called');
      const t0 = Date.now();
      const out = await bus.call<SearchInput, SearchOutput>('memory:index:search', ctx, {
        query: question.text,
        topK,
      });
      const retrievedDocs: RetrievedDoc[] = out.results.map((r) => ({
        path: r.docId,
        score: r.score,
        summary: r.summary,
      }));
      return {
        retrievedDocs,
        latencyMs: Date.now() - t0,
        embeddingTokens: 0,
        rerankTokens: 0,
      };
    },
  };
}

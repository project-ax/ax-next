import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'node:path';
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

export type EmbedInputType = 'document' | 'query';

export interface EmbedClient {
  embed(
    texts: string[],
    inputType: EmbedInputType,
  ): Promise<{ vectors: number[][]; tokens: number }>;
}

export interface ConfigCOptions extends ConfigFactoryOptions {
  embedClient: EmbedClient;
  embeddingDim?: number;
  rrfK?: number;
  candidateK?: number;
}

export function rrfFuse(
  bm25: Array<{ path: string; score: number }>,
  vector: Array<{ path: string; score: number }>,
  opts: { k: number; topK: number },
): Array<{ path: string; score: number }> {
  const fused = new Map<string, number>();
  bm25.forEach((d, i) => fused.set(d.path, (fused.get(d.path) ?? 0) + 1 / (opts.k + i + 1)));
  vector.forEach((d, i) => fused.set(d.path, (fused.get(d.path) ?? 0) + 1 / (opts.k + i + 1)));
  return [...fused.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK);
}

export function createConfigC(opts: ConfigCOptions): ConfigDriver {
  const bm = createConfigA(opts);
  let db: Database.Database | null = null;
  let corpusRef: BenchCorpus | null = null;
  // zembed-1 default output is 2560-dim. Allowed values per the SDK:
  // [2560, 1280, 640, 320, 160, 80, 40]. Override via embeddingDim if you
  // want a smaller index (and pass `dimensions: N` to the embed factory).
  const dim = opts.embeddingDim ?? 2560;
  const rrfK = opts.rrfK ?? 60;
  const candidateK = opts.candidateK ?? 30;
  let totalEmbedTokens = 0;

  return {
    name: 'c-rrf',
    async build(corpus: BenchCorpus) {
      corpusRef = corpus;
      await bm.build(corpus);
      const vecPath = join(opts.tempDir, `${corpus.name}.vec.db`);
      db = new Database(vecPath);
      sqliteVec.load(db);
      db.exec(`CREATE VIRTUAL TABLE docs USING vec0(embedding float[${dim}]);`);
      db.exec(`CREATE TABLE doc_map (rowid INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);`);
      // vec0 does not support explicit rowid on insert — let it auto-assign and capture lastInsertRowid.
      const insertVec = db.prepare(`INSERT INTO docs(embedding) VALUES (?)`);
      const insertMap = db.prepare(`INSERT INTO doc_map(rowid, path) VALUES (?, ?)`);
      const paths = [...corpus.memoryTree.keys()];
      const texts = paths.map((p) => {
        const d = corpus.memoryTree.get(p)!;
        return `${d.summary}\n${d.headers}`;
      });
      const embed = await opts.embedClient.embed(texts, 'document');
      totalEmbedTokens += embed.tokens;
      const txn = db.transaction(() => {
        for (let i = 0; i < paths.length; i++) {
          const { lastInsertRowid } = insertVec.run(Buffer.from(new Float32Array(embed.vectors[i]!).buffer));
          insertMap.run(lastInsertRowid, paths[i]!);
        }
      });
      txn();
    },
    async teardown() {
      if (db) { db.close(); db = null; }
      corpusRef = null;
      await bm.teardown();
    },
    async retrieve(
      question: BenchQuestion,
      topK: number,
      signal: AbortSignal,
    ): Promise<RetrievalResult> {
      if (!db || !corpusRef) throw new Error('Config C: build() not called');
      const t0 = Date.now();
      const [bmResult, qEmbed] = await Promise.all([
        bm.retrieve(question, candidateK, signal),
        opts.embedClient.embed([question.text], 'query'),
      ]);
      totalEmbedTokens += qEmbed.tokens;
      const qVecBuf = Buffer.from(new Float32Array(qEmbed.vectors[0]!).buffer);
      const vecHits = db.prepare(
        `SELECT m.path AS path, d.distance AS distance
         FROM docs d JOIN doc_map m USING (rowid)
         WHERE d.embedding MATCH ? AND k = ?
         ORDER BY distance ASC`,
      ).all(qVecBuf, candidateK) as Array<{ path: string; distance: number }>;
      const vecList = vecHits.map((h) => ({ path: h.path, score: -h.distance }));
      const bmList = bmResult.retrievedDocs.map((d) => ({ path: d.path, score: d.score }));
      const fused = rrfFuse(bmList, vecList, { k: rrfK, topK });
      const retrievedDocs: RetrievedDoc[] = fused.map((f) => ({
        path: f.path,
        score: f.score,
        summary: corpusRef!.memoryTree.get(f.path)?.summary ?? '',
      }));
      return {
        retrievedDocs,
        latencyMs: Date.now() - t0,
        embeddingTokens: totalEmbedTokens,
        rerankTokens: 0,
      };
    },
  };
}

export function makeZeroEntropyEmbedClient(apiKey: string, model = 'zembed-1'): EmbedClient {
  const z = new ZeroEntropy({ apiKey });
  return {
    async embed(texts, inputType) {
      const resp = await z.models.embed({ model, input: texts, input_type: inputType });
      const vectors = resp.results.map((r) => {
        if (typeof r.embedding === 'string') {
          throw new Error('zembed-1 returned a base64 embedding; this client expects float arrays');
        }
        return r.embedding;
      });
      return { vectors, tokens: resp.usage.total_tokens };
    },
  };
}

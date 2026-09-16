import type Database from "better-sqlite3";
import { openDatabase } from "./db/client.js";
import { MemoryRepository } from "./db/memory-repository.js";
import { CoOccurrenceGraph } from "./graph/co-occurrence-graph.js";
import { RecallEngine, type RecallResult } from "./engine/recall.js";
import { ReflectEngine, type ReflectResult } from "./engine/reflect.js";
import {
  RetainEngine,
  createOpenAIExtractor,
  type RetainResult,
} from "./engine/retain.js";
import {
  createVertexEmbedder,
  hashEmbedder,
} from "./models/embeddings.js";
import { createCohereReranker, lexicalReranker } from "./models/reranker.js";
import type {
  DialogueTurn,
  EmbeddingFn,
  EpistemicNetwork,
  ExtractFn,
  GenerateFn,
  IngestionPayload,
  RecallOptions,
  RerankFn,
} from "./types.js";

export interface DemMemoryOptions {
  path?: string;
  bankId?: string;
  embed?: EmbeddingFn;
  embedProvider?: "vertex" | "hash";
  extract?: ExtractFn;
  extractModel?: string;
  generate?: GenerateFn;
  generateModel?: string;
  rerank?: RerankFn | "cohere" | "lexical" | "none";
  dispositionSkepticism?: number;
  dispositionLiteralism?: number;
  dispositionEmpathy?: number;
  maxContextTokens?: number;
  rrfK?: number;
}

export interface MemoryStats {
  bankId: string;
  total: number;
  active: number;
  byNetwork: Record<EpistemicNetwork, number>;
  graphNodes: number;
  graphEdges: number;
}

export interface DemMemory {
  readonly bankId: string;
  readonly database: Database.Database;
  retain(
    input: string | DialogueTurn[] | IngestionPayload,
    options?: { bankId?: string; now?: string },
  ): Promise<RetainResult>;
  recall(query: string, options?: RecallOptions): Promise<RecallResult>;
  reflect(question: string, options?: RecallOptions): Promise<ReflectResult>;
  setBank(bankId: string): void;
  stats(): MemoryStats;
  close(): void;
}

function resolveEmbedder(options: DemMemoryOptions): EmbeddingFn {
  if (options.embed) return options.embed;
  const provider =
    options.embedProvider ??
    (process.env.DEM_EMBED_PROVIDER as "vertex" | "hash" | undefined) ??
    "vertex";
  if (provider === "hash") return hashEmbedder();
  return createVertexEmbedder();
}

function resolveReranker(rerank: DemMemoryOptions["rerank"]): RerankFn | null {
  if (rerank === "none") return null;
  if (rerank === "lexical") return lexicalReranker();
  if (typeof rerank === "function") return rerank;
  if (process.env.DEM_RERANKER === "none") return null;
  if (process.env.DEM_RERANKER === "lexical") return lexicalReranker();
  return createCohereReranker();
}

export function createDemMemory(options: DemMemoryOptions = {}): DemMemory {
  const db = openDatabase({ path: options.path });
  const repository = new MemoryRepository(db);
  const graph = new CoOccurrenceGraph();

  let bankId = options.bankId ?? "default";

  const rebuildGraph = (bank: string): void => {
    for (const batch of repository.batches(bank)) graph.coOccur(batch);
  };
  rebuildGraph(bankId);

  const embed = resolveEmbedder(options);
  const extract = options.extract ?? createOpenAIExtractor({ model: options.extractModel });
  const rerank = resolveReranker(options.rerank);

  let recallEngine = new RecallEngine(repository, graph, bankId, embed, {
    rerank,
    rrfK: options.rrfK,
  });
  const retainEngine = new RetainEngine(repository, graph, embed, extract, bankId);
  const reflectEngine = new ReflectEngine(recallEngine, options.generate ?? null, {
    maxContextTokens: options.maxContextTokens,
    disposition: {
      skepticism: options.dispositionSkepticism ?? 3,
      literalism: options.dispositionLiteralism ?? 3,
      empathy: options.dispositionEmpathy ?? 3,
    },
  });

  return {
    get bankId(): string {
      return bankId;
    },
    get database(): Database.Database {
      return db;
    },
    async retain(input, retainOptions) {
      return retainEngine.retain(input, {
        bankId: retainOptions?.bankId,
        now: retainOptions?.now,
      });
    },
    async recall(query, recallOptions) {
      return recallEngine.recall(query, recallOptions);
    },
    async reflect(question, reflectOptions) {
      return reflectEngine.reflect(question, reflectOptions);
    },
    setBank(nextBank: string) {
      bankId = nextBank;
      graph.clear();
      rebuildGraph(bankId);
      recallEngine = new RecallEngine(repository, graph, bankId, embed, {
        rerank,
        rrfK: options.rrfK,
      });
    },
    stats() {
      const counts = repository.counts(bankId);
      return {
        bankId,
        ...counts,
        graphNodes: graph.nodes().length,
        graphEdges: graph.edgeCount(),
      };
    },
    close() {
      db.close();
    },
  };
}

export {
  ExtractedFactSchema,
  IngestionPayloadSchema,
  type DispositionProfile,
  type DialogueTurn,
  type EmbeddingFn,
  type EmbeddingTask,
  type EpistemicNetwork,
  type ExtractedFact,
  type ExtractFn,
  type GenerateFn,
  type IngestionPayload,
  type MemoryTuple,
  type RecallOptions,
  type RerankFn,
} from "./types.js";
export { openDatabase } from "./db/client.js";
export { MemoryRepository, buildFtsMatchQuery, vectorToBlob } from "./db/memory-repository.js";
export { CoOccurrenceGraph, matchEntities } from "./graph/co-occurrence-graph.js";
export {
  RecallEngine,
  reciprocalRankFusion,
  type RecallResult,
} from "./engine/recall.js";
export {
  ReflectEngine,
  buildReflectSystemPrompt,
  compileEvidenceTable,
  createOpenAIAnswerer,
  evidenceTableRow,
  formatWhen,
  relativeTime,
  type CompiledEvidence,
  type CompileEvidenceOptions,
  type ReflectResult,
} from "./engine/reflect.js";
export {
  RetainEngine,
  buildExtractionPrompt,
  createOpenAIExtractor,
  type RetainResult,
} from "./engine/retain.js";
export { createVertexEmbedder, hashEmbedder } from "./models/embeddings.js";
export { createCohereReranker, lexicalReranker } from "./models/reranker.js";

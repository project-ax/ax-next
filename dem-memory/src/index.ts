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
  type IdStrategy,
  type SupersessionMode,
  type SupersessionOptions,
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
  Provenance,
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
  /** Rerank pool size. Raise it alongside a raised evidence-row limit. */
  rerankPool?: number;
  /** Append verbatim source dialogue for the top N evidence rows (0 = off). */
  sourceExcerpts?: number;
  /**
   * Which rule retires a statement. Defaults to `invalidates-previous`, which is DEM as
   * shipped and what the 87.4% baseline was measured with — NOT because it is the better
   * rule. See `SupersessionMode` for the measurement that says it is not.
   */
  supersession?: SupersessionMode;
  /**
   * How a relation becomes a slot under `supersession: 'slot'`. Defaults to the exact-synonym
   * table; the embedding alternative is exported from `./slots.js` and measured at 13.2%
   * precision, which is why it is not the default.
   */
  slotNormalizer?: SupersessionOptions["normalizer"];
  /**
   * How a stored row gets its id, and therefore how retrieval breaks ranking ties. Defaults
   * to `random`, which is what DEM has always done and is measurably NOT reproducible — see
   * `IdStrategy` and `bench/reproducibility-probe.ts`.
   */
  idStrategy?: IdStrategy;
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
    options?: {
      bankId?: string;
      now?: string;
      sourceText?: string;
      sourceChunkChars?: number;
      /** Who is asserting these. Decided by the CALLER's path, never by a model-filled field. */
      provenance?: Provenance;
    },
  ): Promise<RetainResult>;
  /** Close statements explicitly — the UI's delete. Returns the ids actually closed. */
  forget(ids: readonly string[], at?: string): string[];
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
    ...(options.rerankPool !== undefined ? { rerankPool: options.rerankPool } : {}),
  });
  const supersession: SupersessionOptions = {
    ...(options.supersession !== undefined ? { mode: options.supersession } : {}),
    ...(options.slotNormalizer !== undefined ? { normalizer: options.slotNormalizer } : {}),
  };
  const retainEngine = new RetainEngine(
    repository,
    graph,
    embed,
    extract,
    bankId,
    supersession,
    options.idStrategy ?? "random",
  );
  const reflectEngine = new ReflectEngine(recallEngine, options.generate ?? null, {
    maxContextTokens: options.maxContextTokens,
    sourceExcerpts: options.sourceExcerpts ?? 0,
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
        ...(retainOptions?.bankId ? { bankId: retainOptions.bankId } : {}),
        ...(retainOptions?.now ? { now: retainOptions.now } : {}),
        ...(retainOptions?.sourceText ? { sourceText: retainOptions.sourceText } : {}),
        ...(retainOptions?.sourceChunkChars ? { sourceChunkChars: retainOptions.sourceChunkChars } : {}),
        ...(retainOptions?.provenance ? { provenance: retainOptions.provenance } : {}),
      });
    },
    async recall(query, recallOptions) {
      return recallEngine.recall(query, recallOptions);
    },
    async reflect(question, reflectOptions) {
      return reflectEngine.reflect(question, reflectOptions);
    },
    forget(ids, at) {
      return repository.supersede(bankId, ids, at ?? new Date().toISOString());
    },
    setBank(nextBank: string) {
      bankId = nextBank;
      graph.clear();
      rebuildGraph(bankId);
      recallEngine = new RecallEngine(repository, graph, bankId, embed, {
        rerank,
        rrfK: options.rrfK,
        ...(options.rerankPool !== undefined ? { rerankPool: options.rerankPool } : {}),
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
  type Provenance,
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
  type SkippedFact,
  type IdStrategy,
  type SupersessionMode,
  type SupersessionOptions,
} from "./engine/retain.js";
export {
  SLOTS,
  SLOT_DESCRIPTIONS,
  SLOT_SYNONYMS,
  assignSlot,
  assignSlotFromScores,
  cosine,
  embeddingNormalizer,
  relationToWords,
  slotSignature,
  synonymNormalizer,
  type Slot,
  type SlotAssignment,
  type SlotNormalizer,
} from "./slots.js";
export { createVertexEmbedder, hashEmbedder } from "./models/embeddings.js";
export { createCohereReranker, lexicalReranker } from "./models/reranker.js";

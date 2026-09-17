import type { MemoryRepository } from "../db/memory-repository.js";
import { buildFtsMatchQuery } from "../db/memory-repository.js";
import { matchEntities, type CoOccurrenceGraph } from "../graph/co-occurrence-graph.js";
import {
  DEFAULT_RRF_K,
  memoryStatement,
  normalizeTimestamp,
  type EmbeddingFn,
  type MemoryTuple,
  type RerankFn,
  type RecallOptions,
} from "../types.js";

export interface RecallResult {
  query: string;
  temporalAnchor?: string;
  asOf?: string;
  tuples: MemoryTuple[];
  scores: number[];
  reranked: boolean;
  channels: {
    sparse: string[];
    dense: string[];
    graph: string[];
    temporal: string[];
  };
}

export interface RecallEngineOptions {
  bankId: string;
  graph: CoOccurrenceGraph;
  embed: EmbeddingFn;
  rerank?: RerankFn | null;
  rrfK?: number;
  channelLimit?: number;
  rerankPool?: number;
}

export interface FusedCandidate {
  id: string;
  score: number;
}

export function reciprocalRankFusion(lists: string[][], k = DEFAULT_RRF_K): FusedCandidate[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export class RecallEngine {
  private readonly rerank: RerankFn | null;
  private readonly rrfK: number;
  private readonly channelLimit: number;
  private readonly rerankPool: number;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly graph: CoOccurrenceGraph,
    private readonly bankId: string,
    private readonly embed: EmbeddingFn,
    options: { rerank?: RerankFn | null; rrfK?: number; channelLimit?: number; rerankPool?: number } = {},
  ) {
    this.rerank = options.rerank ?? null;
    this.rrfK = options.rrfK ?? DEFAULT_RRF_K;
    this.channelLimit = options.channelLimit ?? 40;
    // Raise this alongside a raised `limit`: a table longer than the pool has its tail in raw
    // RRF order. Cohere bills one search unit for up to 100 documents, so widening is free.
    this.rerankPool = options.rerankPool ?? 40;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const limit = Math.max(1, options.limit ?? 15);
    const temporalAnchor = options.temporalAnchor
      ? normalizeTimestamp(options.temporalAnchor, "temporalAnchor")
      : undefined;
    // Carried through for presentation only — deliberately not handed to any channel.
    const asOf = options.asOf ? normalizeTimestamp(options.asOf, "asOf") : undefined;

    const [queryVector] = await this.embed([query], "query");
    if (!queryVector) {
      return emptyResult(query, temporalAnchor, asOf);
    }

    const sparse = this.sparseChannel(query, temporalAnchor);
    const dense = this.repository.searchVec(
      this.bankId,
      queryVector,
      this.channelLimit * 4,
      temporalAnchor,
      this.channelLimit,
    );
    const graph = this.graphChannel(query, temporalAnchor);
    const temporal = this.repository
      .temporal(this.bankId, temporalAnchor, this.channelLimit)
      .map((tuple) => tuple.id);

    const fused = reciprocalRankFusion([sparse, dense, graph, temporal], this.rrfK);
    let ranked: FusedCandidate[] = fused;
    let reranked = false;
    if (this.rerank !== null && fused.length > 0) {
      const pool = fused.slice(0, this.rerankPool);
      const poolTuples = this.repository.getByIds(pool.map((candidate) => candidate.id));
      const statementById = new Map(
        poolTuples.map((tuple) => [
          tuple.id,
          memoryStatement(tuple.subject, tuple.predicate, tuple.object),
        ]),
      );
      const documents = pool.map((candidate) => statementById.get(candidate.id) ?? "");
      const scores = await this.rerank(query, documents);
      const reordered = pool
        .map((candidate, index) => ({ candidate, score: scores[index] ?? 0 }))
        .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
        .map((entry) => entry.candidate);
      const poolIds = new Set(reordered.map((candidate) => candidate.id));
      ranked = [...reordered, ...fused.filter((candidate) => !poolIds.has(candidate.id))];
      reranked = true;
    }

    const selected = ranked.slice(0, limit);
    const tuples = this.repository.getByIds(selected.map((candidate) => candidate.id));

    return {
      query,
      temporalAnchor,
      asOf,
      tuples,
      scores: selected.map((candidate) => candidate.score),
      reranked,
      channels: { sparse, dense, graph, temporal },
    };
  }

  private sparseChannel(query: string, temporalAnchor: string | undefined): string[] {
    const match = buildFtsMatchQuery(query);
    if (match === null) return [];
    return this.repository.searchFts(this.bankId, match, temporalAnchor, this.channelLimit);
  }

  private graphChannel(query: string, temporalAnchor: string | undefined): string[] {
    const seeds = matchEntities(query, this.graph.nodes());
    if (seeds.length === 0) return [];
    const { neighbors } = this.graph.neighborhood(seeds, { hops: 2, decay: 0.5 });
    const rankBySubject = new Map<string, number>();
    seeds.forEach((entity, index) => rankBySubject.set(entity, index));
    [...neighbors.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([entity], index) => rankBySubject.set(entity, seeds.length + index));
    const rows = this.repository.memoriesBySubjects(
      this.bankId,
      [...rankBySubject.keys()],
      temporalAnchor,
      this.channelLimit,
    );
    return rows
      .map((tuple) => ({ tuple, rank: rankBySubject.get(tuple.subject) ?? Number.MAX_SAFE_INTEGER }))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.tuple.transactionTime.localeCompare(b.tuple.transactionTime) ||
          a.tuple.id.localeCompare(b.tuple.id),
      )
      .slice(0, this.channelLimit)
      .map((entry) => entry.tuple.id);
  }
}

function emptyResult(
  query: string,
  temporalAnchor: string | undefined,
  asOf: string | undefined,
): RecallResult {
  return {
    query,
    temporalAnchor,
    asOf,
    tuples: [],
    scores: [],
    reranked: false,
    channels: { sparse: [], dense: [], graph: [], temporal: [] },
  };
}

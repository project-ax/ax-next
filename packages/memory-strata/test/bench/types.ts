// Shared types for the Strata Phase 3 eval harness.
// See docs/plans/2026-05-12-memory-strata-phase-3-design.md.

export interface MarkdownDoc {
  path: string;          // e.g. "docs/entities/people/john-doe.md"
  category: string;      // "entities" | "knowledge" | "episodes" | "procedures" | "system"
  slug: string;          // e.g. "john-doe"
  summary: string;       // YAML-frontmatter summary
  factType: string;      // YAML-frontmatter fact_type
  headers: string;       // section headers joined newline
  body: string;          // full markdown body (used for indexing)
}

export interface BenchQuestion {
  id: string;
  text: string;
  goldAnswer: string;
  goldDocIds?: string[];  // optional: dataset-provided list of relevant doc paths for recall@k
  metadata?: Record<string, unknown>;
}

export interface BenchCorpus {
  name: 'longmemeval-s' | 'locomo' | 'internal';
  memoryTree: Map<string, MarkdownDoc>;   // key = doc.path
  questions: BenchQuestion[];
}

export type ConfigName = 'a-bm25' | 'b-rerank' | 'c-rrf';

export interface RetrievedDoc {
  path: string;
  score: number;
  summary: string;
}

export interface RetrievalResult {
  retrievedDocs: RetrievedDoc[];
  latencyMs: number;
  embeddingTokens: number;
  rerankTokens: number;
}

export interface ConfigDriver {
  name: ConfigName;
  build(corpus: BenchCorpus): Promise<void>;
  teardown(): Promise<void>;
  retrieve(question: BenchQuestion, topK: number, signal: AbortSignal): Promise<RetrievalResult>;
}

export type Verdict = 'correct' | 'incorrect' | 'uncertain';

export interface QuestionResult {
  corpus: BenchCorpus['name'];
  config: ConfigName;
  question: BenchQuestion;
  retrieval: RetrievalResult;
  agentAnswer: string;
  verdict: Verdict;
  judgeReason: string;
  agentTokens: { in: number; out: number };
  judgeTokens: { in: number; out: number };
  totalDollars: number;
}

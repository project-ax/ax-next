import { z } from "zod";

export type EpistemicNetwork = "world" | "experience" | "observation" | "opinion";

/**
 * Who asserted a statement. Ordered: a row is only ever closed by a row of equal-or-higher
 * provenance, so a person's correction survives the next time the extractor meets the old
 * value in a transcript.
 */
export type Provenance = "extracted" | "agent" | "human";

export const PROVENANCE_RANK: Readonly<Record<Provenance, number>> = {
  extracted: 0,
  agent: 1,
  human: 2,
};

export interface MemoryTuple {
  id: string;
  bankId: string;
  network: EpistemicNetwork;
  subject: string;
  predicate: string;
  object: string;
  /** Verbatim dialogue the fact came from, when a source turn could be attributed. */
  sourceChunk?: string;
  validStart: string;
  validEnd: string;
  transactionTime: string;
  /**
   * DERIVED from `predicate`; the key slot supersession matches on. Absent means "no slot",
   * which means this row closes nothing and no slot rule closes it.
   */
  slot?: string;
  provenance: Provenance;
  /** The id of the row that closed this one. Absent on an active row AND on an explicit delete. */
  closedBy?: string;
}

export const ExtractedFactSchema = z.object({
  network: z.enum(["world", "experience", "opinion"]),
  subject: z.string().describe("Canonicalized entity identifier in snake_case"),
  predicate: z.string().describe("Normalized relationship or property in snake_case"),
  object: z.string().describe("Concise statement of fact, preference, or outcome"),
  validStart: z.string().describe("ISO-8601 UTC date-time string marking when the statement became true"),
  invalidatesPrevious: z.boolean().describe("Set to true if this statement updates or supersedes a prior state")
});

export const IngestionPayloadSchema = z.object({
  facts: z.array(ExtractedFactSchema)
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;
export type IngestionPayload = z.infer<typeof IngestionPayloadSchema>;

export interface DispositionProfile {
  skepticism: number; // Scale: 1 to 5
  literalism: number; // Scale: 1 to 5
  empathy: number; // Scale: 1 to 5
}

export interface RecallOptions {
  limit?: number;
  /**
   * Bi-temporal time travel: return the bank as it stood at this instant. Filters the
   * candidate set to records whose validity interval covers the anchor.
   */
  temporalAnchor?: string;
  /**
   * The wall-clock time the question is being asked at. Used to resolve relative
   * expressions ("last Saturday", "how many weeks ago") when presenting evidence.
   * Presentation only — it never filters what is recalled.
   */
  asOf?: string;
  maxContextTokens?: number;
  /** Append verbatim source dialogue for the top N ranked rows that carry it. */
  sourceExcerpts?: number;
}

export interface DialogueTurn {
  role: "user" | "assistant" | "system";
  content: string;
  at?: string;
}

export type ExtractFn = (dialogue: string, context: { now: string }) => Promise<IngestionPayload>;

export type EmbeddingTask = "document" | "query";

export type EmbeddingFn = (texts: string[], task?: EmbeddingTask) => Promise<number[][]>;

export type RerankFn = (query: string, documents: string[]) => Promise<number[]>;

export type GenerateFn = (input: { system: string; prompt: string }) => Promise<string>;

export const INFINITY_SENTINEL = "9999-12-31T23:59:59.999Z";

export const DEFAULT_DISPOSITION: DispositionProfile = {
  skepticism: 3,
  literalism: 3,
  empathy: 3,
};

export const DEFAULT_MAX_CONTEXT_TOKENS = 2000;

/**
 * Evidence rows per answer, by default.
 *
 * MEASURED, and the reason this is still 15: filling the 2000-token budget instead (a median
 * 34 rows) scored 88.0% vs 83.0% on a GLM answerer but 87.0% vs 88.0% on a Sonnet answerer —
 * i.e. it did not replicate — while costing 1.93x the answer-prompt tokens. Across 10 flips in
 * the two arms exactly one replicated. Treat 83-88% at n=100 as one number and keep the cheap
 * setting. Raise it per-call via `RecallOptions.limit` to fill the budget instead.
 */
export const DEFAULT_EVIDENCE_ROWS = 15;

/**
 * Upper bound when a caller DOES opt into filling the token budget. Not a default — see above.
 * `compileEvidenceTable` trims by token budget in rank order; this only stops a pathologically
 * terse bank from producing a table of hundreds of rows.
 */
export const DEFAULT_EVIDENCE_ROW_CAP = 80;

export const DEFAULT_RRF_K = 60;

export function normalizeTimestamp(value: string, label = "timestamp"): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO-8601 ${label}: ${JSON.stringify(value)}`);
  }
  return parsed.toISOString();
}

/**
 * Render a tuple as the one sentence that gets embedded, reranked, and shown to the answerer.
 *
 * `subject` and `predicate` are snake_case identifiers by extraction contract, so their
 * underscores are separators and get spaced out. `object` is FREE TEXT and is passed through
 * verbatim: its underscores are content. Spacing them out turned the stored handle
 * `@jessica_poole_jewellery` into `@jessica poole jewellery`, and the answerer reported a
 * handle that does not exist (LongMemEval b759caee).
 */
export function memoryStatement(subject: string, predicate: string, object: string): string {
  const words = (value: string): string => value.replace(/_/g, " ").trim();
  return `${words(subject)} ${words(predicate)}: ${object.trim()}`;
}

export function flattenDialogue(input: string | DialogueTurn[]): string {
  if (typeof input === "string") return input;
  return input
    .map((turn) => `${turn.at ? `[${turn.at}] ` : ""}${turn.role}: ${turn.content}`)
    .join("\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// The wire shapes of `embeddings:embed` and `embeddings:rerank`, plus the
// validators that guard them.
//
// THE SCHEMA OF RECORD LIVES HERE, in the directory of the plugin that
// registers the hooks (CLAUDE.md boundary review: "schema lives in this
// plugin's directory, not a central file"). `@ax/memory-facts-sqlite` — the
// consumer — carries a structurally identical copy of these four interfaces in
// `packages/memory-facts-sqlite/src/producers.ts`. That duplication is
// deliberate and permanent: a plugin may not import another plugin's types
// (Invariant 2), so the two declarations are PEERS, not an original and an
// import. Change one and you must change the other; TypeScript will not tell
// you, because nothing links them.
//
// VENDOR NEUTRALITY IS A HARD CONSTRAINT, not a preference (Invariant 1;
// design Appendix B's "`RRF`, `vec0`, `FTS5`, `cosine` do not appear in any
// payload"). No `cosine`, no dimension count, no provider or model-family
// name, no `instances`/`RETRIEVAL_DOCUMENT`-style vendor enum: a Vertex-shaped,
// a Cohere-shaped and an on-cluster producer all have to be able to satisfy
// these without the caller knowing which it got. The local mode in `local.ts`
// is the fourth such implementation, and it has neither a network nor a model
// name — if a field only made sense for one of the four, it would leak.

import { PluginError } from '@ax/core';

export const EMBED_HOOK = 'embeddings:embed';
export const RERANK_HOOK = 'embeddings:rerank';

/** This plugin's name, as it appears on every `PluginError` it throws. */
export const PLUGIN_NAME = '@ax/embeddings';

/**
 * `task` is the one field that looks like it might leak and does not: "am I
 * embedding a stored document or a search query" is a property of the CALLER's
 * intent, not of any backend, and every embedding API worth using distinguishes
 * them (asymmetric models score noticeably worse when the two are conflated).
 * A producer whose model has no such distinction — the local mode, for one —
 * ignores it.
 */
export type EmbeddingTask = 'document' | 'query';

export interface EmbedInput {
  texts: string[];
  task: EmbeddingTask;
  /** Producer-native model id, when the deployment pinned one. */
  model?: string;
}

export interface EmbedOutput {
  /** One vector per input text, in input order. */
  vectors: number[][];
}

export interface RerankInput {
  query: string;
  documents: string[];
  /** Producer-native model id, when the deployment pinned one. */
  model?: string;
}

export interface RerankOutput {
  /** One relevance score per input document, in input order. Higher is better. */
  scores: number[];
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
//
// These are not style checks. Every string that arrives here is destined for an
// outbound network payload once the remote drivers land, and the strings are
// user memory — facts a person told their agent. An unbounded batch is both an
// unbounded egress of that memory and an unbounded bill. Bounding it at the
// entrance means the ceiling is enforced once, in the plugin that owns the
// hook, rather than in each of N drivers.

/** Most texts/documents one call may carry. */
export const MAX_ITEMS = 256;

/** Longest single text/document/query, in UTF-16 code units. */
export const MAX_CHARS = 8192;

function invalid(hookName: string, message: string): PluginError {
  return new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, hookName, message });
}

function asRecord(hookName: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(hookName, 'payload must be an object');
  }
  return value as Record<string, unknown>;
}

/** A bounded array of bounded strings. An EMPTY array is legal — see the parsers. */
function parseStringArray(hookName: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid(hookName, `${field} must be an array of strings`);
  if (value.length > MAX_ITEMS) {
    throw invalid(hookName, `${field} must hold at most ${MAX_ITEMS} entries (got ${value.length})`);
  }
  value.forEach((entry, i) => {
    if (typeof entry !== 'string') throw invalid(hookName, `${field}[${i}] must be a string`);
    if (entry.length > MAX_CHARS) {
      throw invalid(hookName, `${field}[${i}] must be at most ${MAX_CHARS} characters (got ${entry.length})`);
    }
  });
  return value as string[];
}

function parseModel(hookName: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(hookName, 'model must be a string when set');
  if (value.length > MAX_CHARS) {
    throw invalid(hookName, `model must be at most ${MAX_CHARS} characters`);
  }
  return value;
}

/**
 * Validate an `embeddings:embed` payload.
 *
 * This runs on input that arrived over the hook bus from ANOTHER plugin, which
 * is a trust boundary (Invariant 5) — so it is checked, not assumed. A
 * malformed payload is a CALLER bug and is thrown loudly as `invalid-payload`;
 * it is not degraded into an empty answer, because a caller that is sending
 * garbage should find out now rather than silently get no vectors.
 *
 * An empty `texts` array is LEGAL and yields `{ vectors: [] }`. The in-repo
 * consumer short-circuits before calling (`producers.ts`'s `embedTexts`), but
 * a future one may not, and "nothing to embed" is not an error.
 */
export function parseEmbedInput(value: unknown): EmbedInput {
  const raw = asRecord(EMBED_HOOK, value);
  const texts = parseStringArray(EMBED_HOOK, 'texts', raw.texts);
  if (raw.task !== 'document' && raw.task !== 'query') {
    throw invalid(EMBED_HOOK, "task must be 'document' or 'query'");
  }
  const model = parseModel(EMBED_HOOK, raw.model);
  return { texts, task: raw.task, ...(model !== undefined ? { model } : {}) };
}

/**
 * Validate an `embeddings:rerank` payload. See {@link parseEmbedInput} for why
 * this is loud rather than lenient.
 *
 * An empty `documents` array is LEGAL and yields `{ scores: [] }`. An empty
 * `query` string is legal too — absent and empty are different things, and the
 * empty one has a well-defined answer (no tokens, so every score is 0).
 */
export function parseRerankInput(value: unknown): RerankInput {
  const raw = asRecord(RERANK_HOOK, value);
  if (typeof raw.query !== 'string') throw invalid(RERANK_HOOK, 'query must be a string');
  if (raw.query.length > MAX_CHARS) {
    throw invalid(RERANK_HOOK, `query must be at most ${MAX_CHARS} characters (got ${raw.query.length})`);
  }
  const documents = parseStringArray(RERANK_HOOK, 'documents', raw.documents);
  const model = parseModel(RERANK_HOOK, raw.model);
  return { query: raw.query, documents, ...(model !== undefined ? { model } : {}) };
}

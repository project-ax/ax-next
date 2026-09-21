// The local-only, network-free mode.
//
// This is a REAL implementation, not a stub — just a much weaker one. The
// embedder produces `dimensions` finite floats, L2-normalized, stable across
// runs and processes, with a similarity that tracks token overlap; that is
// everything a vector store needs to write, `MATCH ... k` read, over-fetch and
// filter for real. The reranker is plain lexical overlap. Ported from
// `dem-memory/src/models/embeddings.ts`'s `hashEmbedder` and
// `dem-memory/src/models/reranker.ts`'s `lexicalReranker` (and the copy of
// `hashVector` that `@ax/memory-facts-sqlite`'s suite already runs against its
// real sqlite store).
//
// WHAT IT COSTS, measured rather than guessed: on the n=30 recall smoke,
// retrieval scored 80.0% with the production reranker and 56.7% without it.
// So local mode is a working system with a materially worse answer, which is
// exactly the trade we want available: a deployment with no provider
// credential, no egress allowance and no bill still gets semantic recall and
// a ranking channel, and the operator can see in one number what turning the
// remote drivers (T2) on buys them.
//
// No network, no credentials, no `process.env`, no clock, no randomness. Given
// the same text it returns the same vector in any process, forever — which is
// what makes vectors written on one boot still comparable on the next.

/** Word tokens: letters and digits, any script. Lowercased. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Signed-bucket FNV-1a hashing over word tokens, then L2-normalize.
 *
 * A text with no word tokens has a zero norm; it returns the all-zero vector
 * rather than dividing by it. That branch is load-bearing — `0/0` is `NaN`,
 * and a vector of NaNs written into a fixed-width vector column compares
 * distances against garbage forever, silently.
 *
 * Always returns exactly `dimensions` finite numbers.
 */
export function hashVector(text: string, dimensions: number): number[] {
  const buckets = new Map<number, number>();
  for (const token of tokenize(text)) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    const sign = hash >>> 31 === 1 ? -1 : 1;
    buckets.set(index, (buckets.get(index) ?? 0) + sign);
  }
  const vector = new Array<number>(dimensions).fill(0);
  for (const [index, value] of buckets) vector[index] = value;
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/** One vector per text, in input order. An empty input yields an empty output. */
export function localEmbed(texts: string[], dimensions: number): number[][] {
  return texts.map((text) => hashVector(text, dimensions));
}

/**
 * Lexical overlap: the share of the query's DISTINCT tokens that a document
 * contains. Exactly `dem-memory`'s `lexicalReranker`, including its answer for
 * the degenerate case — a query with no word tokens scores every document `0`
 * rather than `NaN`, since the consumer drops a non-finite score set entirely
 * and a `NaN` would take the whole ranking channel down with it.
 */
export function localRerank(query: string, documents: string[]): number[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return documents.map(() => 0);
  return documents.map((document) => {
    const docTokens = new Set(tokenize(document));
    let overlap = 0;
    for (const token of queryTokens) {
      if (docTokens.has(token)) overlap += 1;
    }
    return overlap / queryTokens.size;
  });
}

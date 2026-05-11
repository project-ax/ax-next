// Token-set Jaccard similarity (Decision A1 from Phase 2A plan).
//
// WHY this approach: the Consolidator needs to skip observations that
// restate an already-recorded fact. A semantic similarity comparison
// would be more accurate but costs a round-trip to a model and adds
// latency on every chat:end event. Token-set Jaccard is deterministic,
// runs in <1 ms per pair, needs no network, and has zero failure modes
// beyond the bag-of-words blindspot.
//
// WHAT IT DOES NOT DO (deliberately, per YAGNI — Phase 2B/3 concerns):
//   - Semantic equivalence: "fast" vs "speedy" are different tokens.
//   - Paraphrase detection: "she prefers React" vs "React is her preference"
//     will score low even though they mean the same thing.
//   - Multi-lingual: only ASCII alphanumeric tokens are extracted.
//
// If Phase 3's eval harness shows Jaccard recall is too low, the plan calls
// for swapping in embedding-based similarity behind the same `isDupe` API
// — the interface is stable, the heuristic is replaceable.
//
// Stopwords are stripped so short common words (`the`, `a`, `of`) don't
// inflate overlap on short facts (e.g. "the user" vs "the project" would
// get a free 0.5 overlap just from "the" without stripping it).
// Internal only — not part of the public @ax/memory-strata API surface.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the',
  'to', 'was', 'were', 'with',
]);

export interface DedupOptions {
  /** Default 0.6 — two facts at or above this score are considered dupes. */
  threshold?: number;
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0]!;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const tok of a) if (b.has(tok)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function isDupe(
  candidate: string,
  existing: string[],
  options: DedupOptions = {},
): boolean {
  const threshold = options.threshold ?? 0.6;
  const candTokens = tokenize(candidate);
  for (const e of existing) {
    if (jaccard(candTokens, tokenize(e)) >= threshold) return true;
  }
  return false;
}

// Deterministic stratified sampling for a type-ordered corpus.
//
// LongMemEval-S is stored in question_type BLOCKS. Taking the first N is
// therefore not a sample of the corpus, it is a sample of one or two types:
// `--sample 40` is 40 single-session-user questions and nothing else, and
// `--sample 100` is 70 single-session-user + 30 multi-session. Every small-n
// number this repo has published was measured on a slice like that — including
// the n=100 rounds the 2026-05-13 report calls misleading, which now have a
// mechanism. (`e2e-select.ts` had already hit this from the other direction:
// knowledge-update questions start at position 434, so `--sample 100` contains
// none of them.)
//
// No RNG. Proportional allocation by largest remainder, then evenly spaced
// picks WITHIN each stratum — so the same request always yields the same
// questions (a bench you cannot re-run identically is a bench you cannot argue
// with), and a stratum's own internal ordering cannot bias the pick the way
// taking its first k would.

/** Proportional allocation by largest remainder. Sums to exactly `limit`. */
export function allocate(sizes: number[], limit: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return sizes.map(() => 0);
  if (limit >= total) return [...sizes];

  const exact = sizes.map((s) => (s * limit) / total);
  const floors = exact.map(Math.floor);
  let used = floors.reduce((a, b) => a + b, 0);

  // Hand out the remaining seats to the largest fractional parts. Ties break on
  // the lower index, which keeps the result stable across runs.
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  const out = [...floors];
  for (const { i } of order) {
    if (used >= limit) break;
    if (out[i]! >= sizes[i]!) continue; // never allocate more than the stratum holds
    out[i] = out[i]! + 1;
    used += 1;
  }
  return out;
}

/** Evenly spaced indices across `size`, always including the first. */
export function spacedIndices(size: number, take: number): number[] {
  if (take <= 0) return [];
  if (take >= size) return Array.from({ length: size }, (_, i) => i);
  const step = size / take;
  const out: number[] = [];
  for (let k = 0; k < take; k++) out.push(Math.min(size - 1, Math.floor(k * step)));
  return [...new Set(out)];
}

/**
 * Take `limit` items, proportionally across strata, preserving the corpus's
 * original ordering in the result.
 *
 * `keyOf` returning undefined puts an item in one shared stratum, so a corpus
 * with no type labels degrades to an evenly spaced sample rather than failing.
 */
export function stratifiedSample<T>(
  items: readonly T[],
  limit: number,
  keyOf: (item: T) => string | undefined,
): T[] {
  if (limit >= items.length) return [...items];
  if (limit <= 0) return [];

  const strata = new Map<string, number[]>();
  items.forEach((item, idx) => {
    const key = keyOf(item) ?? '__unlabelled__';
    const bucket = strata.get(key);
    if (bucket) bucket.push(idx);
    else strata.set(key, [idx]);
  });

  const keys = [...strata.keys()];
  const counts = allocate(keys.map((k) => strata.get(k)!.length), limit);

  const chosen: number[] = [];
  keys.forEach((k, i) => {
    const idxs = strata.get(k)!;
    for (const pos of spacedIndices(idxs.length, counts[i]!)) chosen.push(idxs[pos]!);
  });

  // Corpus order, not stratum order: a run's progress log should walk the
  // corpus the way an unsampled run does.
  chosen.sort((a, b) => a - b);
  return chosen.map((i) => items[i]!);
}

/** Human-readable stratum mix, for the report's provenance line. */
export function describeMix<T>(items: readonly T[], keyOf: (item: T) => string | undefined): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it) ?? 'unlabelled';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
}

// Moved from the deleted `@ax/memory-strata` package's bench harness (TASK-608
// deleted packages/memory-strata; `parseCorpusDate` is byte-for-byte the
// function from the old `packages/memory-strata/test/bench/e2e-driver.ts`,
// pulled into its own file rather than copying the whole driver — the rest of
// that file imports `@ax/memory-strata`/`@ax/memory-strata-index-sqlite`
// directly, which TASK-608 deleted). Used by `scripts/memory-product-e2e.mjs`
// and `scripts/memory-lifetime-soak.mjs` to parse LongMemEval-S corpus dates.

/** Parse a LongMemEval haystack/question date ("2023/05/20 (Sat) 02:21") to a
 * Date, or null when absent/malformed — null falls back to wall-clock. */
export function parseCorpusDate(raw: string | undefined): Date | null {
  // `haystack_dates` comes from an unchecked `JSON.parse(...) as ...` cast, so a
  // literal JSON `null` (or number) can slip past the declared type — guard on
  // the runtime type, not just `undefined`, so a non-string returns null instead
  // of throwing at `raw.trim()`.
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(raw.trim());
  if (m === null) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

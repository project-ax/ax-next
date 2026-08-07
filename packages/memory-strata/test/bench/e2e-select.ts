// Targeted e2e sample selection. Exists because LongMemEval-S is ordered in
// TYPE BLOCKS (user 70 → multi 133 → preference 30 → temporal 132 →
// knowledge-update 69 → assistant 54), so the first single-session-assistant
// question sits at sample position 434: `--sample 100` contains ZERO of them and
// CANNOT measure an assistant-recall lever at all.
//
// The load-bearing detail is the ORDER: filter, THEN slice. Slicing first and
// filtering the remainder returns an empty set for any type whose block starts
// past the limit — the exact trap this module exists to defeat.
//
// With no filters this is `samples.slice(0, limit)`, byte-identical to the
// pre-existing behavior. Both flags are opt-in; run semantics are unchanged
// unless one is passed.

import type { LongMemEvalSample } from './corpora/longmemeval-s.js';
import type { E2EReportRow } from './e2e-report.js';
import type { E2EResumeRow } from './e2e-resume.js';

export interface SelectSamplesInput {
  /** The full loaded corpus, in corpus order. */
  samples: LongMemEvalSample[];
  /** `question_type` values to keep. Empty/absent = no type filter. */
  types?: string[] | undefined;
  /** `question_id` values to keep. Empty/absent = no id filter. */
  ids?: string[] | undefined;
  /** Max rows to return, applied AFTER filtering. */
  limit: number;
}

/**
 * Filter the corpus by question type and/or id, then cap it at `limit`.
 *
 * `types` and `ids` UNION (a row matching either is kept) so an operator can say
 * "the whole assistant block plus these two specific stragglers". Output stays in
 * corpus order regardless of the order ids were listed in, which keeps a resumed
 * run's ordering stable.
 */
export function selectSamples(input: SelectSamplesInput): LongMemEvalSample[] {
  const { samples, limit } = input;
  const typeSet = input.types && input.types.length > 0 ? new Set(input.types) : null;
  const idSet = input.ids && input.ids.length > 0 ? new Set(input.ids) : null;
  if (typeSet === null && idSet === null) return samples.slice(0, limit);
  const filtered = samples.filter(
    (s) =>
      (typeSet !== null && s.question_type !== undefined && typeSet.has(s.question_type)) ||
      (idSet !== null && idSet.has(s.question_id)),
  );
  return filtered.slice(0, limit);
}

/**
 * Parse a comma-separated CLI flag into a list. Returns undefined (not an empty
 * array) when there's nothing usable, so callers can omit the key entirely under
 * `exactOptionalPropertyTypes`.
 */
export function parseCsvFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Seed a report's `rows` from a resumed run's JSONL, restricted to THIS run's
 * selected sample set (review fix, 2026-07-29). Without this filter, seeding
 * from the entire resume file folds in rows from any other run that happens to
 * share the same resume JSONL — e.g. an unfiltered run's rows leaking into a
 * `--types single-session-assistant` run's per-type table (`resumeId` defaults
 * to today's date, so same-day runs share a file). Resuming the SAME selection
 * (filtered or not) is unaffected: every row it wrote is, by construction, for a
 * question in that selection.
 */
export function seedResumeRows(
  done: Map<string, E2EResumeRow>,
  samples: LongMemEvalSample[],
): E2EReportRow[] {
  const ids = new Set(samples.map((s) => s.question_id));
  const out: E2EReportRow[] = [];
  for (const [questionId, row] of done) {
    if (ids.has(questionId)) out.push(row);
  }
  return out;
}

/**
 * Build the "0 questions matched" integrity-guard message for a `--types`/`--ids`
 * run whose selection is empty (review fix, 2026-07-29) — e.g. a typo'd
 * `--types` value. Extracted as a pure function so the guard is unit-testable
 * without loading the live corpus. Returns undefined when there's nothing to
 * report (a match was found, or no filter was requested at all — an empty
 * unfiltered corpus is not this guard's concern).
 */
export function zeroMatchError(input: {
  types: string[] | undefined;
  ids: string[] | undefined;
  matched: number;
}): string | undefined {
  if (input.matched > 0) return undefined;
  if (input.types === undefined && input.ids === undefined) return undefined;
  return (
    '--types/--ids matched 0 questions' +
    `${input.types ? ` types=[${input.types.join(',')}]` : ''}` +
    `${input.ids ? ` ids=[${input.ids.join(',')}]` : ''}. ` +
    'Refusing to render a report for zero questions — check the values against the corpus ' +
    '(see question_type values in corpora/longmemeval-s.ts).'
  );
}

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

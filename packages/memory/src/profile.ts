import { SLOTS } from './slots.js';

export interface ProfileRow {
  id: string;
  slot?: string;
  provenance?: string;
  when: string;
}

/**
 * The order the profile renders in - `SLOTS` declaration order, frozen into a
 * lookup so the block is byte-stable across runs.
 *
 * The store answers the profile query in RECENCY order, which is the wrong
 * order for a profile: it makes the block churn every time any single fact is
 * re-stated, and a prompt that changes for no reason is one that cannot be
 * cached or diffed. Slot order is arbitrary but stable, which is the property
 * that matters.
 *
 * It lives here rather than in `slots.ts` because it is a RENDERING concern.
 * `slots.ts` owns the vocabulary and the derivation; ordering for both the
 * injected block and the profile surface belongs here.
 */
const SLOT_RANK = new Map<string, number>(SLOTS.map((slot, i) => [slot, i]));

/**
 * Trust rank for picking ONE active row per slot. Higher wins.
 *
 * Two active rows can legitimately share a slot: §3.4's rule 3 closes a row
 * only with one of equal-or-higher provenance, so a `human` row and a later
 * `extracted` row about the same slot both stay active — that immunity is the
 * whole reason a person's correction survives the next chat mention. The
 * profile renders one line per slot, so it has to pick, and picking anything
 * other than the highest-provenance row would undo the immunity at render
 * time and show the person the correction they already overrode.
 */
const PROVENANCE_RANK = new Map<string, number>([
  ['human', 3],
  ['agent', 2],
  ['extracted', 1],
]);

/** Higher provenance wins; equal provenance, the later `when`; then the id, for stability. */
export function selectProfileRows<T extends ProfileRow>(
  rows: readonly T[],
  limit: number,
): T[] {
  const bySlot = new Map<string, T>();
  for (const row of rows) {
    if (typeof row.slot !== 'string' || row.slot === '') continue;
    const held = bySlot.get(row.slot);
    const rank = PROVENANCE_RANK.get(row.provenance ?? '') ?? 0;
    const heldRank = PROVENANCE_RANK.get(held?.provenance ?? '') ?? 0;
    if (
      held === undefined ||
      rank > heldRank ||
      (rank === heldRank &&
        (row.when > held.when || (row.when === held.when && row.id > held.id)))
    )
      bySlot.set(row.slot, row);
  }
  return [...bySlot.entries()]
    // Sort comparator over slot names; unknown slots sort last, then by name.
    .sort(
      ([a], [b]) =>
        (SLOT_RANK.get(a) ?? SLOTS.length) - (SLOT_RANK.get(b) ?? SLOTS.length) ||
        a.localeCompare(b),
    )
    .slice(0, limit)
    .map(([, row]) => row);
}

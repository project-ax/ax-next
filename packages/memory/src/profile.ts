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

export interface SlotGroupRow {
  about: string;
  slot?: string;
  provenance?: string;
  value: string;
  until?: string;
  closedBy?: string;
}

/** Case, whitespace and trailing punctuation don't make a value different. */
function sameValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!,;:]+$/, '');
}

/**
 * "A person's correction survives the next chat mention" (design §3.4) — on
 * the READ path.
 *
 * Rule 3 keeps a lower-provenance row from closing a higher one, so when a
 * person corrects "Portland" to "Seattle" and later says "Portland" in chat,
 * the extracted restatement and the human correction are BOTH active. The
 * profile picks the higher-provenance row; recall is a ranked list, so it
 * has to decide which rows to drop instead.
 *
 * It drops only a RE-MENTION: an active slot row whose value matches a value
 * that was REPLACED earlier in the same `(about, slot)` chain, while a row of
 * higher provenance is active there. That is the stale value coming back. A
 * genuinely new value ("I moved to Coimbra") is not a re-mention and stays
 * visible even under an old human row — the model reads the dated evidence
 * and newest wins, as before. A FORGOTTEN value (closed with no `closedBy`)
 * does not count as replaced: forgetting is not a correction to something
 * else. Slot-less rows are never touched.
 *
 * `group` is every row, active and closed, of the subjects' slot chains,
 * looked up separately by the caller: the replaced row and the correction can
 * both sit outside the retrieved pool while the stale re-mention ranks inside.
 */
export function dropRementionedSlotRows<T extends SlotGroupRow>(
  rows: readonly T[],
  group: readonly SlotGroupRow[],
): T[] {
  const key = (row: SlotGroupRow): string => `${row.about}\u0000${row.slot}`;
  const topActiveRank = new Map<string, number>();
  const replaced = new Map<string, Set<string>>();
  for (const row of [...group, ...rows]) {
    if (typeof row.slot !== 'string' || row.slot === '') continue;
    if (row.until === undefined) {
      const rank = PROVENANCE_RANK.get(row.provenance ?? '') ?? 0;
      if (rank > (topActiveRank.get(key(row)) ?? 0)) topActiveRank.set(key(row), rank);
    } else if (typeof row.closedBy === 'string') {
      const values = replaced.get(key(row)) ?? new Set<string>();
      values.add(sameValue(row.value));
      replaced.set(key(row), values);
    }
  }
  return rows.filter((row) => {
    if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) return true;
    const rank = PROVENANCE_RANK.get(row.provenance ?? '') ?? 0;
    const outranked = rank < (topActiveRank.get(key(row)) ?? 0);
    return !(outranked && replaced.get(key(row))?.has(sameValue(row.value)));
  });
}

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

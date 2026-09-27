import { SLOTS } from './slots.js';

export interface ProfileRow {
  id: string;
  about: string;
  slot?: string;
  provenance?: string;
  value: string;
  when: string;
  until?: string;
  closedBy?: string;
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
 * Trust rank. Used two ways, and only two:
 *
 * - by {@link rementionedSlotRows}, to ask whether a re-mention sits under a
 *   higher-provenance active row (the recall path);
 * - by {@link selectProfileRows}, to single out `human` rows (a person's own
 *   edit is authoritative) and to break a tie on `when`.
 *
 * It is NOT "highest provenance wins the profile" any more (TASK-602): among
 * non-human rows the newest non-re-mention value wins. Storage rule 3 is a
 * separate thing and still uses `human > agent > extracted` for closure.
 */
const PROVENANCE_RANK = new Map<string, number>([
  ['human', 3],
  ['agent', 2],
  ['extracted', 1],
]);

export interface SlotGroupRow {
  /** Present on every stored row; lets the profile pick look up a closer. */
  id?: string;
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
  const drop = rementionedSlotRows(rows, group);
  return rows.filter((row) => !drop.has(row));
}

/**
 * The rows of `rows` that {@link dropRementionedSlotRows} hides. History
 * reads mark these instead of dropping them; one function decides both so
 * the hide rule and the mark rule cannot drift.
 */
export function rementionedSlotRows<T extends SlotGroupRow>(
  rows: readonly T[],
  group: readonly SlotGroupRow[],
): Set<T> {
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
  return new Set(
    rows.filter((row) => {
      if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) return false;
      const rank = PROVENANCE_RANK.get(row.provenance ?? '') ?? 0;
      const outranked = rank < (topActiveRank.get(key(row)) ?? 0);
      return outranked && replaced.get(key(row))?.has(sameValue(row.value)) === true;
    }),
  );
}

/**
 * One active row per slot — the row the profile SHOWS (TASK-602 ruling).
 *
 * Two active rows can share a single-valued slot, because §3.4's rule 3 closes
 * a row only with one of equal-or-higher provenance: a later `extracted` row
 * cannot close an `agent` or `human` one. That storage rule is unchanged. What
 * the profile renders from the survivors is decided here:
 *
 * 1. **A person's own edit (`human`) is authoritative.** If the slot holds any
 *    active human row, the newest human row is shown, whatever came after it.
 *    This is the immunity that lets a correction survive the next chat mention.
 * 2. **Otherwise the newest value wins** — an `agent` note is model output
 *    too, and "I moved to Tacoma" in a later chat must replace the agent's
 *    older "Seattle" (the TASK-596 walk found it did not).
 * 3. **Except a re-mention.** A candidate whose value was already REPLACED in
 *    the same `(about, slot)` chain (a closed row with a `closedBy` successor)
 *    is the stale value coming back, not news, so it does not count as newer —
 *    the same test `rementionedSlotRows` applies on the recall path. A
 *    forgotten value (closed with no successor) is not a replaced one.
 *
 * Ties on `when` go to the higher provenance, then the id, so the pick is
 * stable across input order.
 *
 * `history` is every row, active and closed, of the slot chains — read
 * separately by the caller, because the replaced row sits outside an
 * active-only page. Without it no candidate can be recognised as a re-mention
 * and the newest non-human value simply wins. Closed rows passed in `rows`
 * are never candidates and also count as history.
 */
export function selectProfileRows<T extends ProfileRow>(
  rows: readonly T[],
  limit: number,
  history: readonly SlotGroupRow[] = [],
): T[] {
  const chainKey = (row: { about: string; slot?: string }): string =>
    JSON.stringify([row.about, row.slot]);
  const known = [...history, ...rows];
  const byId = new Map<string, SlotGroupRow>();
  for (const row of known) if (typeof row.id === 'string') byId.set(row.id, row);
  const replaced = new Map<string, Set<string>>();
  for (const row of known) {
    if (typeof row.slot !== 'string' || row.slot === '') continue;
    if (row.until === undefined || typeof row.closedBy !== 'string') continue;
    // Closed by a restatement of the SAME value is not a replacement of it:
    // an agent note that says "Seattle" again must not turn itself into a
    // re-mention of the extracted "Seattle" it closed.
    const successor = byId.get(row.closedBy);
    if (successor !== undefined && sameValue(successor.value) === sameValue(row.value)) continue;
    const values = replaced.get(chainKey(row)) ?? new Set<string>();
    values.add(sameValue(row.value));
    replaced.set(chainKey(row), values);
  }

  const bySlot = new Map<string, T[]>();
  for (const row of rows) {
    if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) continue;
    const bucket = bySlot.get(row.slot);
    if (bucket === undefined) bySlot.set(row.slot, [row]);
    else bucket.push(row);
  }

  const rankOf = (row: ProfileRow): number => PROVENANCE_RANK.get(row.provenance ?? '') ?? 0;
  const HUMAN = PROVENANCE_RANK.get('human')!;
  // Newest first; equal `when` → higher provenance; then the id.
  const newer = (a: T, b: T): boolean =>
    a.when > b.when ||
    (a.when === b.when && (rankOf(a) > rankOf(b) || (rankOf(a) === rankOf(b) && a.id > b.id)));
  const newest = (candidates: readonly T[]): T =>
    candidates.reduce((held, row) => (newer(row, held) ? row : held));

  const picked = new Map<string, T>();
  for (const [slot, candidates] of bySlot) {
    const human = candidates.filter((row) => rankOf(row) >= HUMAN);
    if (human.length > 0) {
      picked.set(slot, newest(human));
      continue;
    }
    const fresh = candidates.filter(
      (row) => replaced.get(chainKey(row))?.has(sameValue(row.value)) !== true,
    );
    // Every candidate a re-mention: there is no fresh value to prefer, so fall
    // back to the plain newest rather than showing nothing.
    picked.set(slot, newest(fresh.length > 0 ? fresh : candidates));
  }

  return [...picked.entries()]
    // Sort comparator over slot names; unknown slots sort last, then by name.
    .sort(
      ([a], [b]) =>
        (SLOT_RANK.get(a) ?? SLOTS.length) - (SLOT_RANK.get(b) ?? SLOTS.length) ||
        a.localeCompare(b),
    )
    .slice(0, limit)
    .map(([, row]) => row);
}

/**
 * True when some slot holds two or more active non-human rows — the only case
 * in which {@link selectProfileRows} consults `history` (a human row decides
 * its slot outright, and a lone candidate has nothing to beat). Lets a caller
 * skip the extra chain read in the common case.
 */
export function hasContestedSlot(rows: readonly ProfileRow[]): boolean {
  const HUMAN = PROVENANCE_RANK.get('human')!;
  const humanSlots = new Set<string>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) continue;
    if ((PROVENANCE_RANK.get(row.provenance ?? '') ?? 0) >= HUMAN) humanSlots.add(row.slot);
    else counts.set(row.slot, (counts.get(row.slot) ?? 0) + 1);
  }
  return [...counts].some(([slot, n]) => n >= 2 && !humanSlots.has(slot));
}

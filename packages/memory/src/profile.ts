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
  /** Closed by a person's "it was never right" — see {@link isRetracted}. */
  neverTrue?: boolean;
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
  /** Closed by a person's "it was never right" — see {@link isRetracted}. */
  neverTrue?: boolean;
}

/**
 * A row a person said was NEVER right (TASK-624's `neverTrue`): closed, with
 * no successor. For re-mention purposes it is REPLACED, not forgotten — the
 * person rejected the value itself, so the same value said again in chat is
 * the stale value coming back, not news (TASK-633). A Forget (closed, no
 * successor, no bit) still is not, and a reinstate clears the bit.
 */
function isRetracted(row: SlotGroupRow): boolean {
  return row.until !== undefined && row.neverTrue === true;
}

/**
 * The retracted values of each `(about, slot)` chain, keyed by `key`.
 *
 * TASK-639 ruling (Vinay, 2026-09-28): a value a person marked never right
 * must never resurface ON ITS OWN. A non-human row carrying one is hidden
 * outright — with or without a rival in its slot — on both read paths. Only a
 * person restating it (a `human` row) brings it back.
 */
function retractedValues(
  rows: readonly SlotGroupRow[],
  key: (row: SlotGroupRow) => string,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (typeof row.slot !== 'string' || row.slot === '' || !isRetracted(row)) continue;
    const values = out.get(key(row)) ?? new Set<string>();
    values.add(sameValue(row.value));
    out.set(key(row), values);
  }
  return out;
}

const TRAILING_PUNCTUATION = new Set(['.', '!', ',', ';', ':']);

/** Case, whitespace and trailing punctuation don't make a value different. */
function sameValue(value: string): string {
  const collapsed = value.toLowerCase().replace(/\s+/g, ' ').trim();
  // Trailing punctuation stripped by a backwards scan, not `/[.!,;:]+$/`:
  // that regex backtracks quadratically on a long punctuation run that is
  // not at the end, and `value` is model output (CodeQL js/polynomial-redos).
  let end = collapsed.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(collapsed[end - 1]!)) end -= 1;
  return collapsed.slice(0, end);
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
 * else. A RETRACTED one (closed as never right, TASK-633) does — and more:
 * a retracted value said again on any non-human row is dropped whether or not
 * anything outranks it (TASK-639 ruling), so it never resurfaces on its own.
 * Slot-less rows are never touched.
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
    } else if (typeof row.closedBy === 'string' || isRetracted(row)) {
      const values = replaced.get(key(row)) ?? new Set<string>();
      values.add(sameValue(row.value));
      replaced.set(key(row), values);
    }
  }
  const retracted = retractedValues([...group, ...rows], key);
  const HUMAN = PROVENANCE_RANK.get('human')!;
  return new Set(
    rows.filter((row) => {
      if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) return false;
      const rank = PROVENANCE_RANK.get(row.provenance ?? '') ?? 0;
      // A retracted value said again by anyone but a person: hidden, rival or
      // not (TASK-639).
      if (rank < HUMAN && retracted.get(key(row))?.has(sameValue(row.value)) === true) return true;
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
 *    forgotten value (closed with no successor, no never-right bit) is not a
 *    replaced one. If every candidate is a re-mention, the plain newest is
 *    shown rather than nothing (TASK-602's fallback).
 * 4. **A retracted value never shows on its own** (TASK-639 ruling). A
 *    candidate whose value a person said was NEVER right (TASK-624/633) is
 *    dropped before rules 2-3, so not even the fallback brings it back; a slot
 *    left with no candidate shows nothing. A person restating a retracted
 *    value is a `human` row and wins under rule 1.
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
    if (typeof row.closedBy === 'string' && row.until !== undefined) {
      // Closed by a restatement of the SAME value is not a replacement of it:
      // an agent note that says "Seattle" again must not turn itself into a
      // re-mention of the extracted "Seattle" it closed.
      const successor = byId.get(row.closedBy);
      if (successor !== undefined && sameValue(successor.value) === sameValue(row.value)) continue;
    } else if (!isRetracted(row)) {
      continue;
    }
    const values = replaced.get(chainKey(row)) ?? new Set<string>();
    values.add(sameValue(row.value));
    replaced.set(chainKey(row), values);
  }
  const retracted = retractedValues(known, chainKey);

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
    // A retracted value is never shown on a non-human row's say-so — not even
    // by the fallback below (TASK-639). A slot left with none shows nothing.
    const allowed = candidates.filter(
      (row) => retracted.get(chainKey(row))?.has(sameValue(row.value)) !== true,
    );
    if (allowed.length === 0) continue;
    const fresh = allowed.filter(
      (row) => replaced.get(chainKey(row))?.has(sameValue(row.value)) !== true,
    );
    // Every candidate a re-mention of a REPLACED value: there is no fresh
    // value to prefer, so fall back to the plain newest rather than showing
    // nothing (TASK-602).
    picked.set(slot, newest(fresh.length > 0 ? fresh : allowed));
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
 * True when some slot holds an active non-human row and no active human row —
 * the only case in which {@link selectProfileRows} consults `history` (a human
 * row decides its slot outright). Lets a caller skip the extra chain read when
 * every slot is settled by a person's own edit.
 *
 * A LONE non-human candidate needs the history too (TASK-639): it has nothing
 * to beat, but it may be a re-mention of a value the person retracted, and
 * that is hidden rather than shown. This used to require two candidates.
 */
export function needsSlotHistory(rows: readonly ProfileRow[]): boolean {
  const HUMAN = PROVENANCE_RANK.get('human')!;
  const humanSlots = new Set<string>();
  const otherSlots = new Set<string>();
  for (const row of rows) {
    if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) continue;
    if ((PROVENANCE_RANK.get(row.provenance ?? '') ?? 0) >= HUMAN) humanSlots.add(row.slot);
    else otherSlots.add(row.slot);
  }
  return [...otherSlots].some((slot) => !humanSlots.has(slot));
}

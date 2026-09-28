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
  /** Who spoke the turn an extracted row came from — see {@link restatedByPerson}. */
  sourceRole?: string;
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
  /** Who spoke the turn an extracted row came from — see {@link restatedByPerson}. */
  sourceRole?: string;
}

/**
 * A row a person said was NEVER right (TASK-624's `neverTrue`): closed, with
 * no successor. For re-mention purposes it is REPLACED, not forgotten — the
 * person rejected the value itself, so the same value said again in chat is
 * the stale value coming back, not news (TASK-633). A Forget (closed, no
 * successor, no bit) still is not, and a reinstate clears the bit.
 *
 * Exported for the observer's write-time check on SLOT-LESS rows (TASK-654,
 * `twins.ts`'s `hasRetractedTwin`), which no chain here can reach: one rule
 * for what "retracted" means, on both sides.
 */
export function isRetracted(row: Pick<SlotGroupRow, 'until' | 'neverTrue'>): boolean {
  return row.until !== undefined && row.neverTrue === true;
}

/**
 * The retracted values of each `(about, slot)` chain, keyed by `key`.
 *
 * TASK-639 ruling (Vinay, 2026-09-28): a value a person marked never right
 * must never resurface ON ITS OWN. A non-human row carrying one is hidden
 * outright — with or without a rival in its slot — on both read paths. Only a
 * person restating it brings it back: a `human` row, or — TASK-648 — the
 * person saying it in their own chat message ({@link restatedByPerson}).
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

/**
 * Whether `value` is retracted in the `(about, slot)` chain `chain` holds —
 * the test {@link restatedByPerson} applies, for the observer's write-time
 * twin check (TASK-649). One rule, so the write side cannot keep a row the
 * read side would not resurface.
 */
export function isRetractedValue(
  chain: readonly SlotGroupRow[],
  about: string,
  slot: string,
  value: string,
): boolean {
  const key = (row: Pick<SlotGroupRow, 'about' | 'slot'>): string => `${row.about}\u0000${row.slot}`;
  return retractedValues(chain, key).get(key({ about, slot }))?.has(sameValue(value)) === true;
}

/**
 * The person restated a value they had marked never right — in their OWN chat
 * message (TASK-648 ruling, Vinay, 2026-09-28).
 *
 * The row is an ACTIVE `extracted` row the observer attributed to one of the
 * person's turns (`sourceRole: 'user'`, stored only when that turn actually
 * contains the fact's words), and its value is retracted in its chain. Such a
 * row counts as the person's own word — the same tier as a `human` row — on
 * both read paths, so it resurfaces the value and, being the newer statement,
 * wins over the correction the retraction came with. A correction made AFTER
 * it still wins (newest person-statement).
 *
 * Deliberately narrow:
 * - The agent repeating the value in its reply (`sourceRole: 'assistant'`),
 *   an agent note, and a row whose speaker is unknown stay hidden (TASK-639).
 * - Only a RETRACTED value gets this. A REPLACED one restated in chat behaves
 *   exactly as before (TASK-602/633) — the ruling left that alone.
 * - The row's provenance is untouched: it is still `extracted`, so who SAVED
 *   it (TASK-526's savedBy) and every storage closure rule are unchanged.
 */
function restatedByPerson(
  row: SlotGroupRow,
  retracted: ReadonlyMap<string, ReadonlySet<string>>,
  key: (row: SlotGroupRow) => string,
): boolean {
  return (
    row.until === undefined &&
    row.provenance === 'extracted' &&
    row.sourceRole === 'user' &&
    retracted.get(key(row))?.has(sameValue(row.value)) === true
  );
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
  const retracted = retractedValues([...group, ...rows], key);
  const HUMAN = PROVENANCE_RANK.get('human')!;
  // A person's own chat restatement of a retracted value ranks as theirs
  // (TASK-648) — for outranking others and for not being hidden itself.
  const rankOf = (row: SlotGroupRow): number =>
    restatedByPerson(row, retracted, key) ? HUMAN : (PROVENANCE_RANK.get(row.provenance ?? '') ?? 0);
  const topActiveRank = new Map<string, number>();
  const replaced = new Map<string, Set<string>>();
  for (const row of [...group, ...rows]) {
    if (typeof row.slot !== 'string' || row.slot === '') continue;
    if (row.until === undefined) {
      const rank = rankOf(row);
      if (rank > (topActiveRank.get(key(row)) ?? 0)) topActiveRank.set(key(row), rank);
    } else if (typeof row.closedBy === 'string' || isRetracted(row)) {
      const values = replaced.get(key(row)) ?? new Set<string>();
      values.add(sameValue(row.value));
      replaced.set(key(row), values);
    }
  }
  return new Set(
    rows.filter((row) => {
      if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) return false;
      const rank = rankOf(row);
      // A retracted value said again by anyone but a person: hidden, rival or
      // not (TASK-639). The person's own chat message counts (TASK-648).
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
 *    value is a `human` row and wins under rule 1 — and so is the person
 *    saying it in their own chat message (TASK-648, {@link restatedByPerson}),
 *    which joins rule 1's tier: the newest person-statement is shown.
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

  const HUMAN = PROVENANCE_RANK.get('human')!;
  // A person's own chat restatement of a retracted value is the person's word
  // (TASK-648): it joins rule 1's human tier below.
  const rankOf = (row: ProfileRow): number =>
    restatedByPerson(row, retracted, chainKey)
      ? HUMAN
      : (PROVENANCE_RANK.get(row.provenance ?? '') ?? 0);
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
 *
 * And a slot a human row DOES hold still needs it when an extracted row there
 * came from the person's own turn (TASK-648): it may restate a value they
 * retracted, which then outranks the correction — and only the chain's closed
 * rows can say so.
 */
export function needsSlotHistory(rows: readonly ProfileRow[]): boolean {
  const HUMAN = PROVENANCE_RANK.get('human')!;
  const humanSlots = new Set<string>();
  const otherSlots = new Set<string>();
  for (const row of rows) {
    if (typeof row.slot !== 'string' || row.slot === '' || row.until !== undefined) continue;
    if ((PROVENANCE_RANK.get(row.provenance ?? '') ?? 0) >= HUMAN) humanSlots.add(row.slot);
    else if (row.provenance === 'extracted' && row.sourceRole === 'user') return true;
    else otherSlots.add(row.slot);
  }
  return [...otherSlots].some((slot) => !humanSlots.has(slot));
}

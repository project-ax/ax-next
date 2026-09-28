/**
 * Twins — an extracted statement that restates something the agent (or the
 * person) already saved in the same conversation (TASK-641).
 *
 * ## The problem
 *
 * When a person says "I'm relocating to Denver in November", the agent often
 * saves it with `memory_note` during the turn, and the observer then extracts
 * the same fact from the same message once the turn is over. Two rows, one
 * fact, under relations that differ only in their separators
 * (`relocating to` vs `relocating_to`, `product go-live date` vs
 * `product_go_live_date` — measured on the TASK-629 walk). A Fix or a Forget
 * on one left the other showing.
 *
 * ## The rule
 *
 * The observer drops an extracted statement when the same conversation
 * already holds an agent- or human-saved row (active OR closed) that has:
 *
 * 1. the same `about`;
 * 2. the same relation once case and `_` / `-` / whitespace are folded;
 * 3. shared VALUE words — at least two, or the only one when either value
 *    has just one — ignoring stopwords and the words the relation and
 *    subject already carry.
 *
 * The higher tier survives because it already outranks the extracted row
 * (design §3.4, `human > agent > extracted`). With one row there is nothing to
 * keep in sync: a Fix, an Undo-for-Fix and a Forget-Undo act on the only row
 * there is.
 *
 * Closed rows count because a person may Fix the agent's note inside the idle
 * window, BEFORE the extraction pass runs. The fixed row still carries the old
 * value, so the extractor's restatement of it is recognised and not stored —
 * otherwise the value just fixed away would come straight back.
 *
 * ## The reverse order (TASK-649)
 *
 * When the agent notes, in a later turn, a fact an earlier extraction pass
 * already stored, `memory_note` finds the ACTIVE extracted twin
 * ({@link findActiveExtractedTwin}) and writes nothing: the extracted row is
 * the one row. And one exception runs the other way — the observer keeps a
 * twin the person said in their own turn when its value is one they had
 * marked never right (see `observer.ts`'s `withoutTwins`), so TASK-648's
 * restatement is not dropped behind an agent note.
 *
 * ## Why the value check, and why so blunt
 *
 * The relation key alone would drop a second value of a multi-valued relation
 * (`likes_artist`: Radiohead noted, Bjork extracted). The shared-word check
 * keeps those apart without a model or an embedder — the same exact-or-nothing
 * posture `slots.ts` takes, for the same asymmetric reason: under-matching
 * leaves the pre-TASK-641 duplicate, over-matching loses a fact. One shared
 * word is not enough between multi-word values: a shared leading verb or
 * modifier ("Learn Spanish" / "Learn French", "Thai food" / "Italian food")
 * is common and names two facts. Known residual: a one-word value contained
 * in the other ("Spanish" / "Learn Spanish") is a twin, and two multi-word
 * values sharing two content words are too.
 *
 * Pure and synchronous. Every input is model output, so nothing here indexes
 * a plain object with it.
 */

import { isRetracted } from './profile.js';

/** Provenance tiers that suppress an extracted twin. */
const HIGHER_TIERS: ReadonlySet<string> = new Set(['agent', 'human']);

/**
 * Words that carry no identity of their own. Deliberately short: a missing
 * stopword costs a spurious match only when two values share nothing else.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'he', 'her', 'his', 'i', 'in', 'is', 'it', 'its', 'my', 'of', 'on', 'or', 'our',
  'she', 'that', 'the', 'their', 'they', 'this', 'to', 'was', 'we', 'were', 'will',
  'with', 'you', 'your', 'user', 'assistant',
]);

export interface TwinCandidate {
  about: string;
  relation: string;
  value: string;
}

/** A row already stored for the conversation, as the twin check reads it. */
export interface PriorRow extends TwinCandidate {
  /** Absent means unknown, and unknown is never trusted as a higher tier. */
  provenance?: string;
  /** Set when the row is closed (fixed, forgotten, replaced). Absent = active. */
  until?: string;
  /** Closed by a person's "it was never right" (TASK-624) — see {@link hasRetractedTwin}. */
  neverTrue?: boolean;
}

/**
 * `product_go_live_date` and `product go-live date` -> `product go live date`.
 */
export function relationKey(relation: string): string {
  return relation.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The identity-bearing words of a value, minus the given ones. */
function valueWords(value: string, exclude: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words(value)) {
    if (STOPWORDS.has(w) || exclude.has(w)) continue;
    if (w.length < 2 && !/^\p{N}$/u.test(w)) continue;
    out.add(w);
  }
  return out;
}

/** An extracted statement restating an agent- or human-saved `prior` row. */
export function isTwin(statement: TwinCandidate, prior: PriorRow): boolean {
  if (typeof prior.provenance !== 'string' || !HIGHER_TIERS.has(prior.provenance)) return false;
  return sameFact(statement, prior);
}

/**
 * The REVERSE order (TASK-649): an ACTIVE extracted row that an agent note
 * about to be written would restate. Only an active row counts — the note
 * answers "saved" when it is dropped, which is true only while the extracted
 * row still holds the fact. A forgotten or fixed extracted row does not stop
 * the note.
 *
 * The extracted row survives rather than the note because it is the one
 * already stored, and it may carry `sourceRole: 'user'` — the person's own
 * word, which `profile.ts`'s `restatedByPerson` reads (TASK-648). Replacing
 * it with the note would need a closure ("Replaced" in its history) for what
 * is a restatement.
 */
export function findActiveExtractedTwin<T extends PriorRow>(
  note: TwinCandidate,
  prior: readonly T[],
): T | undefined {
  return prior.find((p) => p.provenance === 'extracted' && p.until === undefined && sameFact(note, p));
}

/** Same subject, same relation key, shared value words — the tier-blind core. */
function sameFact(statement: TwinCandidate, prior: TwinCandidate): boolean {
  if (statement.about !== prior.about) return false;
  const key = relationKey(statement.relation);
  if (key === '' || key !== relationKey(prior.relation)) return false;
  const exclude = new Set([...words(key), ...words(statement.about)]);
  const mine = valueWords(statement.value, exclude);
  const theirs = valueWords(prior.value, exclude);
  let shared = 0;
  for (const w of theirs) if (mine.has(w)) shared += 1;
  // Two shared words — or, when either value has only one, that one. A single
  // shared word between two multi-word values is usually a shared verb or
  // modifier ("Learn Spanish" / "Learn French"), not the same fact.
  return shared > 0 && shared >= Math.min(2, mine.size, theirs.size);
}

/**
 * Whether an extracted statement has a twin that is still ACTIVE — an agent
 * or human row saying the same thing right now, rather than only a closed one.
 * The observer's TASK-649 exception reads it: see `observer.ts`'s
 * `withoutTwins`.
 */
export function hasActiveTwin(statement: TwinCandidate, prior: readonly PriorRow[]): boolean {
  return prior.some((p) => p.until === undefined && isTwin(statement, p));
}

/**
 * Whether `statement` restates a row the person said was NEVER right
 * (TASK-654) — any provenance, any conversation the caller read.
 *
 * The read side hides a retracted value only inside a single-valued slot
 * (`profile.ts`, keyed on `(about, slot)` + exact value). A slot-less row is
 * in no chain, and its re-extraction is usually paraphrased ("Relocating to
 * Denver in November" for "Denver, in November 2026"), so nothing on read can
 * match it — TASK-646 measured fuzzy display-time matching and dropped it.
 * The observer asks this instead, before it writes (human ruling, Vinay
 * 2026-09-28: "observer checks at write"), with the same twin rule as
 * everything above and `profile.ts`'s `isRetracted` as the one retraction
 * rule. Tier-blind: an extracted row Fixed as never right is as retracted as
 * an agent note.
 */
export function hasRetractedTwin(statement: TwinCandidate, rows: readonly PriorRow[]): boolean {
  return rows.some((row) => isRetracted(row) && sameFact(statement, row));
}

/**
 * Split `statements` into the ones to store and a count of dropped twins.
 * `spare` keeps a statement that has a twin anyway (TASK-649: the person
 * restating a value they had marked never right).
 */
export function dropTwins<T extends TwinCandidate>(
  statements: readonly T[],
  prior: readonly PriorRow[],
  spare: (statement: T) => boolean = () => false,
): { kept: T[]; twins: number } {
  const kept: T[] = [];
  let twins = 0;
  for (const s of statements) {
    if (prior.some((p) => isTwin(s, p)) && !spare(s)) twins += 1;
    else kept.push(s);
  }
  return { kept, twins };
}

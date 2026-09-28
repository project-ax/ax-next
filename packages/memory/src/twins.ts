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

export function isTwin(statement: TwinCandidate, prior: PriorRow): boolean {
  if (typeof prior.provenance !== 'string' || !HIGHER_TIERS.has(prior.provenance)) return false;
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

/** Split `statements` into the ones to store and a count of dropped twins. */
export function dropTwins<T extends TwinCandidate>(
  statements: readonly T[],
  prior: readonly PriorRow[],
): { kept: T[]; twins: number } {
  const kept: T[] = [];
  let twins = 0;
  for (const s of statements) {
    if (prior.some((p) => isTwin(s, p))) twins += 1;
    else kept.push(s);
  }
  return { kept, twins };
}

import type { ExtractedFact } from './extract.js';

/**
 * A negated statement must never come back out of the extractor as the
 * positive fact (TASK-652).
 *
 * ## Why this matters more since TASK-648
 *
 * "I never lived in Denver" extracted as `user | lives_in | Denver` was always
 * wrong. Since TASK-648 it is also dangerous: the row lands in the `lives_in`
 * slot, attribution finds "Denver" in the person's own turn and stamps it
 * `sourceRole: 'user'`, and `profile.ts`'s `restatedByPerson` then treats it
 * as the person restating a value they had marked never right — bringing back
 * the exact value they rejected, in the same breath as rejecting it again.
 * Even with no retraction, a slotted misreading CLOSES the true value
 * (`slots.ts`: "a false positive closes a true fact").
 *
 * ## Why a filter, not a prompt change
 *
 * The extraction prompt is fingerprint-pinned (`extraction-prompt.ts` has the
 * measurements; its fingerprint test fails on any rewording), and it says
 * nothing about negation today. So the guard is deterministic and sits on
 * what comes OUT, like `self-report.ts` (TASK-612). It is also the only
 * option that is testable without a live model.
 *
 * ## The rule
 *
 * A fact is dropped when BOTH hold:
 *
 * 1. **Its value is only ever negated in the dialogue.** Of the value's
 *    content words that occur in the dialogue at all, at least one does, and
 *    every occurrence of every one of them sits inside a negation's scope.
 *    One un-negated mention anywhere ("I do live in Denver now") is evidence
 *    enough and the fact is kept. A value the dialogue never spells (a
 *    paraphrase) is kept: there is no evidence it was negated.
 * 2. **The fact does not carry the negation itself.** `never_lived_in`,
 *    `dislikes | coffee`, `formerly_lived_in`, `stated | not Denver` are the
 *    faithful readings and are kept. Every slot synonym is affirmative, so a
 *    slotted misreading always falls on the drop side (pinned by test).
 *
 * ## The scope of a negation — words, not grammar
 *
 * A cue (`not`, `never`, `no`, `nor`, `neither`, any `n't`, `cannot`,
 * `used to`) negates up to {@link SCOPE_WORDS} following words. The scope ends
 * early at sentence punctuation, at a clause break (`but`, `and`, `instead`,
 * `now`, …), at a comma that starts a new clause (`, I live in …`), and at an
 * idiom word that means the negation is not about what follows (`can't WAIT
 * to`, `never THOUGHT`, `don't MIND`, `no DOUBT`, `not ONLY`). A bare `No,` is
 * an answer, not a cue: "No, Denver." says Denver.
 *
 * Known limitation (pinned by test): it cannot tell WHOSE statement a
 * negation is about — "my sister doesn't live in Denver; I do" drops the
 * speaker's Denver. Dropping is the direction `slots.ts` calls safe:
 * under-closing is the measured status quo, over-closing loses data.
 *
 * ## Cost, and the input
 *
 * The dialogue is untrusted and this runs synchronously on the host. One
 * linear tokenizing pass (a regex with no nested or adjacent ambiguous
 * quantifiers) builds a word index; each fact is then a handful of lookups.
 * Nothing here is logged.
 */

/** How many words one negation cue reaches. */
const SCOPE_WORDS = 8;

/** Cues that negate what follows. `n't` contractions are matched by suffix. */
const CUES = new Set([
  'not', 'never', 'no', 'nor', 'neither', 'none', 'nobody', 'nowhere', 'cannot',
  // Apostrophe-less spellings of the contractions.
  'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'havent', 'hasnt',
  'hadnt', 'wont', 'wouldnt', 'cant', 'couldnt', 'shouldnt', 'aint',
]);

/** Words that end a negation's scope: a new clause starts here. */
const CLAUSE_BREAKS = new Set([
  'but', 'and', 'though', 'although', 'however', 'instead', 'rather', 'now',
  'actually', 'except', 'while', 'whereas', 'because', 'so', 'yet',
]);

/**
 * Words that, reached inside a scope, mean the negation is an idiom about
 * something else: "can't wait to move to Denver", "never thought I'd love
 * Denver", "don't mind living in Denver", "no doubt Denver is home", "not
 * only Denver".
 */
const IDIOM_STOPS = new Set([
  'wait', 'believe', 'think', 'thought', 'imagine', 'imagined', 'expected', 'mind',
  'doubt', 'only', 'just', 'sure', 'regret', 'regretted', 'happier', 'problem',
  'bad', 'idea', 'worry', 'worries', 'matter',
]);

/** After a comma, these start a new clause, which ends the scope. */
const CLAUSE_STARTS = new Set([
  'i', "i'm", "i've", "i'd", "i'll", 'im', 'ive', 'we', "we're", 'my', 'our', 'it', "it's",
  'its', 'that', 'this', 'he', 'she', 'they', 'you', 'yes', 'yeah', 'sorry', 'please',
]);

/**
 * Words in a fact's own predicate or value that mean it already states the
 * negation (or a negative relation) — the faithful reading, kept.
 */
const POLARITY_MARKERS = new Set([
  ...CUES,
  'non', 'without', 'against', 'formerly', 'former', 'previously', 'previous', 'past',
  'ex', 'used', 'away', 'left', 'stopped', 'quit', 'lacks', 'lacking', 'dislike',
  'dislikes', 'disliked', 'hate', 'hates', 'hated', 'avoid', 'avoids', 'avoided',
  'refuse', 'refuses', 'refused', 'rejects', 'rejected', 'declined', 'allergic', 'anymore',
  'longer',
]);

/** Too common to say anything about which value a fact holds. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'your', 'are', 'was',
  'were', 'has', 'have', 'had', 'but', 'its', 'into', 'about', 'they', 'them',
  'their', 'there', 'what', 'which', 'when', 'will', 'would', 'could', 'should',
  'can', 'just', 'also', 'than', 'then', 'some', 'any', 'all', 'our', 'out', 'his',
  'her', 'she', 'him', 'who', 'how', 'why', 'user', 'assistant',
]);

/**
 * A word (letters/digits, optionally one apostrophe-joined tail: `don't`,
 * `denver's`) or one boundary character. The two alternatives start on
 * disjoint characters and the tail must begin with `'`, so there is no
 * ambiguity to backtrack over.
 */
const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?|[.;:!?\n,–—]/gu;

const SENTENCE_BREAKS = new Set(['.', ';', ':', '!', '?', '\n', '–', '—']);

/** Whether each word of the dialogue was ever said un-negated, and ever negated. */
export type NegationIndex = ReadonlyMap<string, { plain: boolean; negated: boolean }>;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'");
}

function isWord(token: string): boolean {
  return !SENTENCE_BREAKS.has(token) && token !== ',';
}

function isCue(token: string): boolean {
  return CUES.has(token) || token.endsWith("n't");
}

/** `denver's` -> `denver`; `don't` stays `don't`. */
function base(token: string): string {
  return token.endsWith("'s") ? token.slice(0, -2) : token;
}

/** Build the per-word negation index over a dialogue. One pass, linear. */
export function negationIndex(dialogue: string): NegationIndex {
  const tokens = normalize(dialogue).match(TOKEN) ?? [];
  const index = new Map<string, { plain: boolean; negated: boolean }>();
  let remaining = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    if (SENTENCE_BREAKS.has(token)) {
      remaining = 0;
      continue;
    }
    if (token === ',') {
      if (next !== undefined && (CLAUSE_STARTS.has(next) || CLAUSE_BREAKS.has(next))) remaining = 0;
      continue;
    }
    if (CLAUSE_BREAKS.has(token) || IDIOM_STOPS.has(token)) remaining = 0;
    // A bare "No," / "No." is an answer, not a negation of what follows.
    const cue =
      (isCue(token) && !(token === 'no' && (next === undefined || !isWord(next)))) ||
      (token === 'used' && next === 'to');
    const word = base(token);
    const entry = index.get(word) ?? { plain: false, negated: false };
    if (remaining > 0) {
      entry.negated = true;
      remaining -= 1;
    } else {
      entry.plain = true;
    }
    index.set(word, entry);
    if (cue) remaining = token === 'used' ? SCOPE_WORDS + 1 : SCOPE_WORDS;
  }
  return index;
}

function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const token of normalize(text).match(TOKEN) ?? []) {
    if (!isWord(token)) continue;
    const word = base(token);
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    out.push(word);
  }
  return out;
}

function carriesPolarity(fact: Pick<ExtractedFact, 'predicate' | 'object'>): boolean {
  const words = normalize(`${fact.predicate.replace(/_/g, ' ')} ${fact.object}`).match(TOKEN) ?? [];
  return words.some((token) => POLARITY_MARKERS.has(token) || isCue(token));
}

/**
 * True when `fact` is a POSITIVE reading of a value the dialogue only ever
 * negated — see the file header for the rule.
 */
export function isNegatedFact(
  fact: Pick<ExtractedFact, 'predicate' | 'object'>,
  index: NegationIndex,
): boolean {
  if (carriesPolarity(fact)) return false;
  let seen = false;
  for (const word of contentWords(fact.object)) {
    const entry = index.get(word);
    if (entry === undefined) continue;
    if (entry.plain) return false;
    seen = true;
  }
  return seen;
}

/** Drop the facts {@link isNegatedFact} flags; count them. Order preserved. */
export function dropNegatedFacts<T extends ExtractedFact>(
  facts: readonly T[],
  dialogue: string,
): { facts: T[]; negated: number } {
  if (facts.length === 0) return { facts: [], negated: 0 };
  const index = negationIndex(dialogue);
  const kept = facts.filter((fact) => !isNegatedFact(fact, index));
  return { facts: kept, negated: facts.length - kept.length };
}

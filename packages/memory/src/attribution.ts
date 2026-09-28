import type { ExtractedFact } from './extract.js';
import type { IdentifiedTurn } from './transcript.js';

/**
 * Which turn a fact came from — TASK-625.
 *
 * An incremental pass hands the extractor its NEW turns plus up to two
 * preceding turns as read-only context, so "that one" and "the second
 * option" resolve. Two things then have to be decided per fact, and the
 * pinned prompt (`extraction-prompt.ts`, which may not be reworded) can be
 * asked neither:
 *
 * 1. **Which new turn is its source** — stored as `sourceTurnId`, so a UI can
 *    say "from your message". Provenance only, never a retrieval key.
 * 2. **Whether it came from a context turn alone** — in which case it is
 *    dropped: the pass that covered that turn as NEW already extracted it,
 *    and extracting it again is exactly the double-recording this card
 *    forbids.
 *
 * Both are answered deterministically, by word overlap between the fact and
 * each turn. Facts copy their object text from the dialogue (the prompt asks
 * for verbatim names, values and handles), so overlap finds the turn that
 * said it.
 *
 * ## The rule, in order
 *
 * - Score every turn: how many of the fact's words it contains.
 * - A context turn scores STRICTLY higher than every new turn: **dropped**,
 *   counted as `contextOnly`. Strictly, and against the best new turn rather
 *   than "any new turn shares a word": a context fact almost always shares
 *   some ordinary word with a new turn, and a zero-overlap test would let it
 *   through as a duplicate. A tie goes to the new turn — when the evidence
 *   is even, losing a fact is the worse mistake.
 * - Otherwise the best-scoring NEW turn is the source. Ties go to the turn
 *   whose role matches the fact's speaker (`assistant` facts to assistant
 *   turns, everything else to user turns), then to the later turn.
 * - No turn shares a word (a paraphrase): kept, attributed to the last new
 *   turn of the matching role. Dropping it would lose a fact the new turns
 *   may well have produced; there is no evidence it came from context.
 *
 * ## What this cannot see
 *
 * A new turn that only CONFIRMS a context turn ("yes, book that one") yields
 * a fact whose words all live in the context turn, so it is dropped. That is
 * the cost of not being allowed to change the prompt. It is usually bounded,
 * because the pass before extracted the context turn's own facts — but not
 * always: a pass whose batch was DROPPED (timeout, schema failure, every
 * fact unusable) still moves the cursor, so its turns become context without
 * ever having been stored. The primary loss there is the dropped batch, which
 * the `chat:end` path has always had; this only adds the confirming turn.
 *
 * Linear in text length; one Unicode-class regex, no backtracking. The input
 * is untrusted, and nothing here is logged.
 */

export interface AttributedFact extends ExtractedFact {
  sourceTurnId: string;
}

export interface AttributionResult {
  facts: AttributedFact[];
  /** Facts supported only by a context turn, dropped. */
  contextOnly: number;
}

/** Words too common to say anything about where a fact came from. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'your', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'its', 'into', 'about',
  'they', 'them', 'their', 'there', 'what', 'which', 'when', 'will', 'would',
  'could', 'should', 'can', 'just', 'also', 'than', 'then', 'some', 'any',
  'all', 'our', 'out', 'his', 'her', 'she', 'him', 'who', 'how', 'why',
  // The extractor's canonical speaker subjects: every fact carries one, so
  // they would match every turn.
  'user', 'assistant',
]);

const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0];
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

function factWords(fact: ExtractedFact): Set<string> {
  const out = words(fact.object);
  // Subjects are snake_case entity ids (`boston_office`); split them so they
  // can match the prose they were derived from.
  for (const word of words(fact.subject.replace(/_/g, ' '))) out.add(word);
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const word of a) if (b.has(word)) n += 1;
  return n;
}

function speakerRole(fact: ExtractedFact): 'user' | 'assistant' {
  return fact.subject === 'assistant' ? 'assistant' : 'user';
}

export function attributeFacts(
  facts: readonly ExtractedFact[],
  turns: { context: readonly IdentifiedTurn[]; fresh: readonly IdentifiedTurn[] },
): AttributionResult {
  // No new turn means nothing may be attributed, and every fact can only
  // have come from context. The caller never passes this; it is answered
  // rather than assumed.
  if (turns.fresh.length === 0) return { facts: [], contextOnly: facts.length };
  const fresh = turns.fresh.map((turn) => ({ turn, words: words(turn.content) }));
  const context = turns.context.map((turn) => words(turn.content));
  const out: AttributedFact[] = [];
  let contextOnly = 0;

  for (const fact of facts) {
    const want = factWords(fact);
    const role = speakerRole(fact);

    let best: { turn: IdentifiedTurn; score: number; roleMatch: boolean } | undefined;
    for (const candidate of fresh) {
      const score = overlap(want, candidate.words);
      const roleMatch = candidate.turn.role === role;
      // `>=` on a full tie so the LATER turn wins; the list is in order.
      if (
        best === undefined ||
        score > best.score ||
        (score === best.score && (roleMatch || !best.roleMatch))
      ) {
        best = { turn: candidate.turn, score, roleMatch };
      }
    }
    const bestContext = context.reduce((max, ctxWords) => Math.max(max, overlap(want, ctxWords)), 0);
    if (bestContext > (best?.score ?? 0)) {
      contextOnly += 1;
      continue;
    }
    if (best === undefined || best.score === 0) {
      const sameRole = [...turns.fresh].reverse().find((turn) => turn.role === role);
      best = { turn: sameRole ?? turns.fresh[turns.fresh.length - 1]!, score: 0, roleMatch: true };
    }
    out.push({ ...fact, sourceTurnId: best.turn.turnId });
  }
  return { facts: out, contextOnly };
}

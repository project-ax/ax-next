/**
 * Fact links: how does a newer fact relate to an older one about the same subject?
 *
 * The slot normalizer asks Jev to name a profile property from a relation alone, and it
 * cannot do that cleanly (`docs/plans/2026-09-28-dem-jev-normalizer-report.md`). This asks a
 * narrower question with both values in view — the shape of every rung-4 knowledge-update
 * failure, where the old and new value were both stored under different relations and
 * nothing linked them (`egg_stock` 30 dozen -> `has_egg_stock` 20 dozen), and of the
 * multi-session overcount where one bake was stored twice from two sessions.
 *
 * A link is an ANNOTATION, never a closure: a question can ask for the initial value
 * (`07741c44`: "where do I initially keep my old sneakers?"), and a wrong link must cost one
 * answer's framing rather than a fact.
 *
 * Pure: request shape, candidate generation and the threshold rule. Measured by
 * `bench/fact-links-eval.ts`, pinned by `tests/fact-links.test.ts`.
 */
import { JEV_MODEL, type ChoiceQuestion, type DecisionsRequest, type OptionAnswer } from "./jev.js";
import { relationToWords } from "../src/slots.js";

export const LINK_OPTIONS = ["updates", "same_event", "both_true"] as const;
export type LinkOption = (typeof LINK_OPTIONS)[number];
export const LINK_OPTION_SET: ReadonlySet<LinkOption> = new Set(LINK_OPTIONS);

/** The question, as probed on 2026-09-28 (18/19 on the rung-4 failure pairs + hard negatives). */
export const LINK_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions:
    "Fact A and fact B were both remembered about the same subject; B was said on or after A's date. " +
    "How does B relate to A?",
  criteria: {
    updates:
      "B gives a newer value of the same changing property as A (a count, amount, location, plan, record or status changed), so A is no longer current",
    same_event: "A and B describe the very same single event, item or action, just mentioned twice",
    both_true:
      "A and B are different facts that can both be true at once (different events, items, properties or aspects)",
  },
};

export interface LinkFact {
  id: string;
  about: string;
  relation: string;
  value: string;
  /** ISO timestamp; only the date is shown to Jev. */
  when: string;
}

/**
 * `user:<id>` renders as `user`: the owner id is a storage detail that says nothing about the
 * relation between two facts, and leaving it in would make every cache key per-owner.
 */
export function displayAbout(about: string): string {
  return about === "user" || about.startsWith("user:") ? "user" : about;
}

export function buildLinkRequest(a: LinkFact, b: LinkFact, model = JEV_MODEL): DecisionsRequest {
  const show = (fact: LinkFact): Record<string, string> => ({
    when: fact.when.slice(0, 10),
    about: displayAbout(fact.about),
    relation: relationToWords(fact.relation),
    value: fact.value,
  });
  return { model, state: { A: show(a), B: show(b) }, questions: { rel: LINK_QUESTION } };
}

/** A link only when Jev chose `updates` or `same_event` with at least `threshold`. */
export function linkFromAnswer(
  answer: OptionAnswer<LinkOption> | undefined,
  threshold: number,
): Exclude<LinkOption, "both_true"> | null {
  if (!answer || answer.choice === "both_true") return null;
  return answer.p >= threshold ? answer.choice : null;
}

export interface CandidatePair {
  a: string;
  b: string;
  cosine: number;
  /** Shared-rare-word score (Σ idf of shared tokens); 0 when not computed. */
  lexical?: number;
}

export interface CandidateOptions {
  /** Neighbours per fact. */
  k: number;
  /** Cosine floor; below it a pair is not worth a call. */
  minCosine: number;
  /** Which subjects to link. Default: every subject. */
  about?: (about: string) => boolean;
  /**
   * Also take each fact's `lexicalK` earlier neighbours by shared RARE words (idf-weighted,
   * within the bank). Measured need: under `gemini-embedding-001` the sneakers update pair
   * ranks 12th by cosine — its nearest neighbours are other `plans_*` facts — but it shares
   * the bank-rare word "sneakers". Default 0 (vector neighbours only).
   */
  lexicalK?: number;
}

const STOPWORDS = new Set(
  "the and for with that this from their they them have has had was were are will would about into over after before been being than then when what which while also just more most some such very user users assistant plans plan planning wants want like likes using used uses".split(" "),
);

/** Content tokens of a fact: relation words + value, lowercased, stopwords and short words dropped, a crude plural fold. */
export function factTokens(fact: Pick<LinkFact, "relation" | "value">): Set<string> {
  const words = `${fact.relation.replace(/_/g, " ")} ${fact.value}`.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    out.add(word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

/**
 * For each fact B, its `k` nearest EARLIER facts A with the same `about`, above `minCosine`.
 *
 * "Earlier" is the store's own order — `when`, then input order — which is how a write-time
 * pass would see it: B is the fact being recorded, A is what is already there. A fact with no
 * vector gets no candidates (it is counted by the caller, not silently guessed at).
 */
export function candidatePairs(
  facts: readonly LinkFact[],
  vectors: ReadonlyMap<string, Float32Array>,
  options: CandidateOptions,
): CandidatePair[] {
  const ordered = facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => (options.about ? options.about(fact.about) : true))
    .sort((x, y) => x.fact.when.localeCompare(y.fact.when) || x.index - y.index)
    .map(({ fact }) => fact);
  const norms = new Map<string, number>();
  for (const fact of ordered) {
    const v = vectors.get(fact.id);
    if (v) norms.set(fact.id, norm(v));
  }
  const lexicalK = options.lexicalK ?? 0;
  const tokens = new Map<string, Set<string>>();
  const idf = new Map<string, number>();
  if (lexicalK > 0) {
    const df = new Map<string, number>();
    for (const fact of ordered) {
      const t = factTokens(fact);
      tokens.set(fact.id, t);
      for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
    }
    for (const [w, n] of df) idf.set(w, Math.log(ordered.length / n));
  }
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const b = ordered[i];
    if (!b) continue;
    const vb = vectors.get(b.id);
    const nb = norms.get(b.id) ?? 0;
    const byCosine: CandidatePair[] = [];
    const byWords: CandidatePair[] = [];
    for (let j = 0; j < i; j += 1) {
      const a = ordered[j];
      if (!a || a.about !== b.about) continue;
      const va = vectors.get(a.id);
      const na = norms.get(a.id) ?? 0;
      const cosine = vb && va && nb > 0 && na > 0 ? dot(va, vb) / (na * nb) : Number.NaN;
      if (vb && nb > 0 && cosine >= options.minCosine) byCosine.push({ a: a.id, b: b.id, cosine });
      if (lexicalK > 0) {
        const tb = tokens.get(b.id);
        const ta = tokens.get(a.id);
        let score = 0;
        if (tb && ta) for (const w of tb) if (ta.has(w)) score += idf.get(w) ?? 0;
        if (score > 0) byWords.push({ a: a.id, b: b.id, cosine, lexical: score });
      }
    }
    byCosine.sort((x, y) => y.cosine - x.cosine || x.a.localeCompare(y.a));
    byWords.sort((x, y) => (y.lexical ?? 0) - (x.lexical ?? 0) || x.a.localeCompare(y.a));
    const chosen = new Map<string, CandidatePair>();
    for (const p of byCosine.slice(0, options.k)) chosen.set(p.a, p);
    for (const p of byWords.slice(0, lexicalK)) {
      const had = chosen.get(p.a);
      chosen.set(p.a, had ? { ...had, lexical: p.lexical } : p);
    }
    pairs.push(...chosen.values());
  }
  return pairs;
}

/**
 * The slot vocabulary of the DEM-first design, §3.3 — and nothing else.
 *
 * A slot is the key supersession matches on. `predicate` cannot be that key: it is free
 * text, 84,561 distinct values over 130,779 facts, 86.8% of them singletons, and matching
 * on it exactly fails in both directions (`bench/supersession-replay.ts` measures how).
 * So the design splits the two jobs — `relation` stays the free-text label retrieval reads,
 * and `slot` is a derived, closed, single-valued key.
 *
 * Every entry here is SINGLE-VALUED by construction: a person has one current home, one
 * current employer, one birthday. That is what makes "close the previous one" a sound rule.
 * A multi-valued relation (`likes_artist`, `has_sibling`) must never gain a slot, because
 * closure would delete true facts — which is exactly the failure the replay found in DEM's
 * `invalidatesPrevious`.
 *
 * This list IS the profile whitelist of §4.1. One constant, one owner: if a slot is added
 * here it appears in the injected profile block, and if it is removed it stops closing rows.
 *
 * The vocabulary is deliberately generic. LongMemEval is a consumer chatting with an
 * assistant and cannot tell us what an ax agent's slots should be; anything domain-shaped
 * (`prefers_backend`) waits for evidence.
 */

export const SLOTS = [
  "name",
  "pronouns",
  "lives_in",
  "works_at",
  "role",
  "timezone",
  "language",
  "birthday",
] as const;

export type Slot = (typeof SLOTS)[number];

/**
 * What each slot means, in the words the embedder scores against.
 *
 * These are the fixed side of the nearest-neighbour comparison, so their wording is a
 * tuning surface: it decides which relations map. They are phrased as the property, not as
 * an instruction, because the relation being compared is also a property phrase.
 */
export const SLOT_DESCRIPTIONS: Record<Slot, string> = {
  name: "the person's name; what this person is called",
  pronouns: "the person's pronouns; how this person is referred to",
  lives_in: "where the person lives; their city, country or place of residence",
  works_at: "the organisation, company or employer the person works for",
  role: "the person's job title, role, occupation or profession",
  timezone: "the person's time zone",
  language: "the language the person speaks or prefers to be addressed in",
  birthday: "the person's date of birth or birthday",
};

/**
 * Exact spellings that map without asking the embedder.
 *
 * Deliberately SMALL. This is not a hand-built ontology — it is the short list of
 * canonical spellings that must be right whatever the threshold is set to, so that a
 * threshold change cannot silently unmap `lives_in` itself. Everything else earns its
 * mapping from the embedder or gets no slot.
 *
 * Keys are compared after the same normalisation the embedder input gets (lowercased,
 * underscores collapsed to single spaces) so `Lives_In` and `lives in` both land here.
 */
export const SLOT_SYNONYMS: Record<string, Slot> = {
  // name
  "name": "name",
  "full name": "name",
  "first name": "name",
  "last name": "name",
  "is named": "name",
  "goes by": "name",
  // pronouns
  "pronouns": "pronouns",
  "uses pronouns": "pronouns",
  "preferred pronouns": "pronouns",
  // lives_in
  "lives in": "lives_in",
  "lives at": "lives_in",
  "resides in": "lives_in",
  "based in": "lives_in",
  "city of residence": "lives_in",
  // works_at
  "works at": "works_at",
  "works for": "works_at",
  "employed by": "works_at",
  "employer": "works_at",
  // role
  "role": "role",
  "job title": "role",
  "works as": "role",
  "occupation": "role",
  "profession": "role",
  // timezone
  "timezone": "timezone",
  "time zone": "timezone",
  // language
  "language": "language",
  "preferred language": "language",
  "native language": "language",
  // birthday
  "birthday": "birthday",
  "birth date": "birthday",
  "date of birth": "birthday",
  "born on": "birthday",
};

/**
 * `some_relation_name` -> `some relation name`.
 *
 * The extraction contract makes `predicate` snake_case, so its underscores are separators,
 * not content — the same reading `memoryStatement` applies before embedding a statement.
 */
export function relationToWords(relation: string): string {
  return relation.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SlotAssignment {
  slot: Slot | null;
  /** `synonym` when the exact table answered, `embedding` when the nearest neighbour did. */
  via: "synonym" | "embedding" | "none";
  /**
   * The nearest slot REGARDLESS of the threshold, and its cosine.
   *
   * Reported separately from `slot` so a rejected relation still says what it was nearest
   * to. That is the whole near-miss population — the relations a looser bar admits next —
   * and it is where the known-bad fixture comes from.
   */
  nearest: Slot | null;
  /** Cosine against the nearest slot description. 1 for a synonym hit. */
  score: number;
  /** The runner-up's score, for measuring how decisive the win was. */
  runnerUp: number;
}

/**
 * The normalizer itself: exact table, then nearest neighbour over slot descriptions.
 *
 * `slotVectors` and `relationVector` must come from the SAME embedder and task type, or
 * the cosine compares two different spaces and the threshold means nothing.
 */
export function assignSlot(
  relation: string,
  relationVector: readonly number[] | undefined,
  slotVectors: ReadonlyMap<Slot, readonly number[]>,
  threshold: number,
): SlotAssignment {
  if (!relationVector || relationVector.length === 0) {
    return assignSlotFromScores(relation, undefined, threshold);
  }
  const scores = SLOTS.map((slot) => {
    const vector = slotVectors.get(slot);
    return vector ? cosine(relationVector, vector) : Number.NEGATIVE_INFINITY;
  });
  return assignSlotFromScores(relation, scores, threshold);
}

/**
 * The same decision, from precomputed per-slot cosines in `SLOTS` order.
 *
 * This is the form the evaluation caches, and here is why: the only thing any consumer reads
 * off a relation's 384-dimensional vector is its cosine against eight fixed descriptions, so
 * caching the vector stores 48x more than anything uses. Over 84,534 relations that is the
 * difference between ~660 MB and ~10 MB — which stopped being an aesthetic point when the
 * first full run died with ENOSPC at 71% on a machine with 118 MiB free.
 */
export function assignSlotFromScores(
  relation: string,
  scores: readonly number[] | undefined,
  threshold: number,
): SlotAssignment {
  const words = relationToWords(relation);
  const exact = SLOT_SYNONYMS[words];
  if (exact !== undefined) {
    return { slot: exact, via: "synonym", nearest: exact, score: 1, runnerUp: 0 };
  }
  if (!scores || scores.length === 0) {
    return { slot: null, via: "none", nearest: null, score: 0, runnerUp: 0 };
  }

  let best: Slot | null = null;
  let bestScore = -Infinity;
  let secondScore = -Infinity;
  SLOTS.forEach((slot, index) => {
    const score = scores[index] ?? Number.NEGATIVE_INFINITY;
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = slot;
    } else if (score > secondScore) {
      secondScore = score;
    }
  });
  const nearest: Slot | null = best;
  const score = Number.isFinite(bestScore) ? bestScore : 0;
  const runnerUp = Number.isFinite(secondScore) ? secondScore : 0;
  if (best === null || bestScore < threshold) {
    return { slot: null, via: "none", nearest, score, runnerUp };
  }
  return { slot: best, via: "embedding", nearest, score, runnerUp };
}

/**
 * The identity of a scoring run: which descriptions, embedded which way.
 *
 * Two runs that disagree on either produce incomparable cosines, so this goes in the cache
 * file's NAME rather than being checked after the fact — a stale cache is then unreadable
 * rather than silently read as if it were current.
 */
export function slotSignature(task: string): string {
  const material = `${task}\n${SLOTS.map((slot) => `${slot}\u0001${SLOT_DESCRIPTIONS[slot]}`).join("\n")}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const character of material) {
    const code = character.codePointAt(0) ?? 0;
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 + code, 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

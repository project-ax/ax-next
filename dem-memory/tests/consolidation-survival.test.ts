/**
 * The consolidation simulator copies Strata's drop predicates, because dem-memory is a
 * standalone npm project and cannot import `@ax/memory-strata`. A copy that drifts would
 * silently invalidate every survival number it produces, so the first block below is lifted
 * from `packages/memory-strata/src/__tests__/dedup.test.ts` — if Strata's tokenizer,
 * stopword list or threshold changes, these fail here too.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  DUPE_THRESHOLD,
  isDupe,
  jaccard,
  simulate,
  slugify,
  tokenize,
  type CachedFact,
} from "../bench/consolidation-survival.js";
import type { LongMemEvalSample } from "../bench/harness.js";

describe("predicate fidelity with @ax/memory-strata", () => {
  it("tokenize lowercases and extracts content tokens", () => {
    const tokens = tokenize("User prefers React");
    expect(tokens).toContain("user");
    expect(tokens).toContain("prefers");
    expect(tokens).toContain("react");
  });

  it("tokenize strips the stopword list", () => {
    const tokens = tokenize("the user is on a team");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("is")).toBe(false);
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("on")).toBe(false);
    expect(tokens).toContain("user");
    expect(tokens).toContain("team");
  });

  it("jaccard: identical 1, disjoint 0, two empties 1", () => {
    const a = new Set(["user", "prefers", "react"]);
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, new Set(["project", "ships", "friday"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("isDupe is case-insensitive", () => {
    expect(isDupe("User prefers React", ["user prefers react"])).toBe(true);
  });

  it("isDupe: jaccard 0.5 is a dupe at 0.4 but NOT at the default 0.6", () => {
    expect(isDupe("User prefers React", ["User prefers Vue"], 0.4)).toBe(true);
    expect(isDupe("User prefers React", ["User prefers Vue"])).toBe(false);
  });

  it("holds the constants the numbers were measured at", () => {
    expect(DUPE_THRESHOLD).toBe(0.6);
    expect(CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it("slugify falls back to 'general' on empty input", () => {
    expect(slugify("Ticket to Ride")).toBe("ticket-to-ride");
    expect(slugify("  ")).toBe("general");
  });
});

function sample(overrides: Partial<LongMemEvalSample> & { answer_session_ids?: string[] }): LongMemEvalSample {
  return {
    question_id: "q1",
    question_type: "multi-session",
    question: "?",
    answer: "!",
    haystack_session_ids: ["s1", "s2"],
    haystack_dates: ["2023-01-01", "2023-06-01"],
    haystack_sessions: [],
    ...overrides,
  } as LongMemEvalSample;
}

const fact = (o: Partial<CachedFact>): CachedFact => ({
  subject: "user",
  predicate: "owns_camera",
  object: "Canon EOS 80D",
  confidence: 0.95,
  validStart: "2023-01-01T00:00:00.000Z",
  ...o,
});

describe("simulate", () => {
  it("drops a restatement and keeps the distinct fact", () => {
    const facts = new Map<string, CachedFact[]>([
      ["s1", [fact({}), fact({ predicate: "owns_bike", object: "a red Trek road bike" })]],
      ["s2", [fact({})]],
    ]);
    const r = simulate([sample({ answer_session_ids: [] })], facts, "subject");
    expect(r.all.kept).toBe(2);
    expect(r.all.droppedDupe).toBe(1);
  });

  it("applies the confidence gate before dedup", () => {
    const facts = new Map<string, CachedFact[]>([["s1", [fact({ confidence: 0.5 })]], ["s2", []]]);
    const r = simulate([sample({ answer_session_ids: [] })], facts, "subject");
    expect(r.all.droppedConfidence).toBe(1);
    expect(r.all.kept).toBe(0);
  });

  it("keeps the EARLIER fact, so an update is discarded as a restatement", () => {
    // The directional finding: replay is chronological and dedup keeps the first-seen
    // statement, so a later correction to the same fact is the one that dies.
    const facts = new Map<string, CachedFact[]>([
      ["s1", [fact({ predicate: "owns_pet", object: "a cat named Luna, owned about 6 months" })]],
      ["s2", [fact({ predicate: "owns_pet", object: "a cat named Luna, owned about 9 months", validStart: "2023-06-01T00:00:00.000Z" })]],
    ]);
    const r = simulate([sample({ answer_session_ids: [] })], facts, "subject");
    expect(r.all.droppedDupe).toBe(1);
    expect(r.droppedNewerThanSurvivor).toBe(1);
    expect(r.examples[0]?.dropped).toContain("9 months");
    expect(r.examples[0]?.survivor).toContain("6 months");
  });

  it("counts gold-session losses separately and flags a starved question", () => {
    const facts = new Map<string, CachedFact[]>([["s1", [fact({})]], ["s2", [fact({})]]]);
    const r = simulate([sample({ answer_session_ids: ["s2"] })], facts, "subject");
    expect(r.gold.droppedDupe).toBe(1);
    expect(r.gold.kept).toBe(0);
    // s2's only fact was deduped away, so this question has no surviving gold fact.
    expect(r.questionsLosingAllGold).toEqual(["q1"]);
    expect(r.questionsLosingSomeGold).toBe(1);
  });

  it("scope widens what a fact is compared against", () => {
    const facts = new Map<string, CachedFact[]>([
      ["s1", [fact({ subject: "user", predicate: "likes", object: "hiking in the mountains" })]],
      ["s2", [fact({ subject: "alex", predicate: "likes", object: "hiking in the mountains" })]],
    ]);
    // Different subjects -> different docs -> both survive.
    expect(simulate([sample({ answer_session_ids: [] })], facts, "subject").all.kept).toBe(2);
    // One shared pool -> the second is a dupe of the first.
    expect(simulate([sample({ answer_session_ids: [] })], facts, "global").all.droppedDupe).toBe(1);
  });
});

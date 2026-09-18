import { describe, expect, it } from "vitest";
import {
  SLOTS,
  SLOT_DESCRIPTIONS,
  SLOT_SYNONYMS,
  assignSlot,
  cosine,
  relationToWords,
  type Slot,
} from "../bench/slots.js";

/**
 * Hermetic: no embedder, no network. Vectors are hand-built so the threshold behaviour is
 * exact rather than approximately whatever Vertex returned that day. The REAL separation
 * between relations is measured by `bench/normalizer-eval.ts`; what is pinned here is the
 * decision procedure, which is the part a rung-1 implementation has to preserve.
 */

/**
 * One axis per slot, plus a spare. The spare (`SPILL`) is what a near-miss vector leans
 * into: spilling into another SLOT's axis would make that slot the nearest one, which is
 * how the first draft of this fixture accidentally asserted `birthday`.
 */
const DIMS = SLOTS.length + 1;
const SPILL = SLOTS.length;

/** A unit vector pointing at axis `i`. */
function axis(i: number, n = DIMS): number[] {
  const v = new Array<number>(n).fill(0);
  v[i] = 1;
  return v;
}

/** A vector at exactly `target` cosine from `axis(i)`, leaning into the spare axis. */
function atCosine(i: number, target: number, n = DIMS): number[] {
  const v = new Array<number>(n).fill(0);
  v[i] = target;
  v[SPILL] = Math.sqrt(1 - target * target);
  return v;
}

const slotVectors = new Map<Slot, number[]>(SLOTS.map((slot, i) => [slot, axis(i)]));

describe("relationToWords", () => {
  it("reads snake_case underscores as separators, matching the write path", () => {
    expect(relationToWords("lives_in")).toBe("lives in");
    expect(relationToWords("Preferred_Language")).toBe("preferred language");
    expect(relationToWords("  works__at ")).toBe("works at");
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosine(axis(0), axis(0))).toBeCloseTo(1, 10);
    expect(cosine(axis(0), axis(1))).toBeCloseTo(0, 10);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    expect(cosine(new Array<number>(DIMS).fill(0), axis(0))).toBe(0);
  });
});

describe("assignSlot", () => {
  it("answers from the exact synonym table without consulting a vector", () => {
    const result = assignSlot("lives_in", undefined, slotVectors, 0.99);
    expect(result).toMatchObject({ slot: "lives_in", via: "synonym", score: 1 });
  });

  it("maps a relation whose nearest slot clears the threshold", () => {
    const near = atCosine(2, 0.9); // axis 2 is lives_in
    const result = assignSlot("dwells_in", near, slotVectors, 0.8);
    expect(result.slot).toBe("lives_in");
    expect(result.via).toBe("embedding");
  });

  it("refuses a relation whose nearest slot misses the threshold, and still names it", () => {
    const near = atCosine(2, 0.7);
    const result = assignSlot("vacationed_in", near, slotVectors, 0.8);
    expect(result.slot).toBeNull();
    expect(result.via).toBe("none");
    // The near miss still reports WHAT it was nearest to — that is the population a looser
    // threshold admits next, and the reason the eval can print a hand-check list at all.
    expect(result.nearest).toBe("lives_in");
    expect(result.score).toBeCloseTo(0.7, 6);
  });

  it("gives no slot when there is no vector and no synonym", () => {
    const result = assignSlot("provided_solution", undefined, slotVectors, 0.5);
    expect(result).toMatchObject({ slot: null, via: "none", nearest: null, score: 0 });
  });

  it("reports the runner-up so a near-tie is visible as a near-tie", () => {
    // Deliberately equidistant from lives_in (axis 2) and works_at (axis 3).
    const tied = new Array<number>(DIMS).fill(0);
    tied[2] = Math.SQRT1_2;
    tied[3] = Math.SQRT1_2;
    const result = assignSlot("some_relation", tied, slotVectors, 0.5);
    expect(result.score - result.runnerUp).toBeCloseTo(0, 6);
  });

  it("is deterministic in a tie — the first slot in SLOTS order wins", () => {
    const tied = new Array<number>(DIMS).fill(0);
    tied[2] = Math.SQRT1_2;
    tied[3] = Math.SQRT1_2;
    const a = assignSlot("x", tied, slotVectors, 0.5);
    const b = assignSlot("x", tied, slotVectors, 0.5);
    expect(a.slot).toBe(b.slot);
    expect(SLOTS.indexOf(a.slot as Slot)).toBe(2);
  });
});

describe("the slot vocabulary", () => {
  it("is exactly the eight single-valued profile relations of §3.3", () => {
    expect([...SLOTS]).toEqual([
      "name",
      "pronouns",
      "lives_in",
      "works_at",
      "role",
      "timezone",
      "language",
      "birthday",
    ]);
  });

  it("describes every slot — an undescribed slot would silently never match", () => {
    for (const slot of SLOTS) {
      expect(SLOT_DESCRIPTIONS[slot]).toBeTruthy();
    }
  });

  it("only ever points a synonym at a slot that exists", () => {
    for (const [phrase, slot] of Object.entries(SLOT_SYNONYMS)) {
      expect(SLOTS, `synonym ${phrase}`).toContain(slot);
    }
  });

  it("keys every synonym in the normalised form the lookup uses", () => {
    // A key with an underscore or a capital could never be hit: `assignSlot` looks up
    // `relationToWords(relation)`, which has neither.
    for (const phrase of Object.keys(SLOT_SYNONYMS)) {
      expect(relationToWords(phrase), `synonym key ${phrase}`).toBe(phrase);
    }
  });
});

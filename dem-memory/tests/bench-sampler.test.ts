import { describe, expect, it } from "vitest";
import { stratifiedSample } from "../bench/harness.js";
import type { LongMemEvalSample } from "../bench/harness.js";

/** A corpus stored in type blocks, like LongMemEval-S, with an increasing "size" per item. */
function corpus(mix: Record<string, number>): LongMemEvalSample[] {
  const out: LongMemEvalSample[] = [];
  for (const [type, count] of Object.entries(mix)) {
    for (let i = 0; i < count; i += 1) {
      out.push({
        question_id: `${type}-${i}`,
        question_type: type,
        question: "q",
        answer: "a",
        haystack_session_ids: [],
        // Stand-in for haystack size: item i of each block is the i-th smallest.
        haystack_sessions: Array.from({ length: i + 1 }, () => []),
      });
    }
  }
  return out;
}

const MIX = {
  "multi-session": 133,
  "temporal-reasoning": 133,
  "knowledge-update": 78,
  "single-session-user": 70,
  "single-session-assistant": 56,
  "single-session-preference": 30,
};

describe("stratifiedSample", () => {
  it("allocates each type in proportion to the corpus", () => {
    const picked = stratifiedSample(corpus(MIX), 100);
    const counts = new Map<string, number>();
    for (const s of picked) counts.set(s.question_type!, (counts.get(s.question_type!) ?? 0) + 1);
    expect(picked).toHaveLength(100);
    expect(counts.get("multi-session")).toBe(27);
    expect(counts.get("temporal-reasoning")).toBe(27);
    expect(counts.get("single-session-preference")).toBe(6);
  });

  it("spreads picks across each stratum instead of taking its first (or smallest) k", () => {
    // The regression this guards: the original picker took the k shortest haystacks per
    // type, putting every pick in the bottom decile of the corpus size distribution.
    const picked = stratifiedSample(corpus(MIX), 100).filter(
      (s) => s.question_type === "temporal-reasoning",
    );
    const sizes = picked.map((s) => s.haystack_sessions.length).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)]!;
    expect(median).toBeGreaterThan(133 * 0.3);
    expect(Math.max(...sizes)).toBeGreaterThan(133 * 0.8);
  });

  it("makes every prefix proportional, so an interrupted run is still a sample", () => {
    const picked = stratifiedSample(corpus(MIX), 100);
    const firstTwenty = new Set(picked.slice(0, 20).map((s) => s.question_type));
    expect(firstTwenty.size).toBe(Object.keys(MIX).length);
  });

  it("is deterministic — the same request yields the same questions", () => {
    const a = stratifiedSample(corpus(MIX), 60).map((s) => s.question_id);
    const b = stratifiedSample(corpus(MIX), 60).map((s) => s.question_id);
    expect(a).toEqual(b);
  });

  it("returns the whole corpus when the limit meets or exceeds it", () => {
    expect(stratifiedSample(corpus({ a: 5 }), 5)).toHaveLength(5);
    expect(stratifiedSample(corpus({ a: 5 }), 9)).toHaveLength(5);
    expect(stratifiedSample(corpus({ a: 5 }), 0)).toHaveLength(0);
  });
});

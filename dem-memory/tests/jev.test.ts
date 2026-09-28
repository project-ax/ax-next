import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DecisionCache,
  NO_SLOT,
  SLOT_QUESTION,
  SpendCapError,
  SpendMeter,
  assignSlotWithJev,
  buildSlotRequest,
  decisionCacheKey,
  isRetryableStatus,
  parseSlotResponse,
  slotCriteria,
  slotFromAnswer,
  type ChoiceAnswer,
} from "../bench/jev.js";
import { SLOTS, SLOT_DESCRIPTIONS } from "../src/slots.js";

/**
 * Hermetic: no network. What is pinned is the request Jev is shown, how its answer is read,
 * and the threshold rule — the parts a production normalizer would have to preserve. What
 * Jev actually answers is measured by `bench/jev-normalizer-eval.ts`.
 */

/** The live response shape, verbatim from the probe call of 2026-09-28. */
const LIVE = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    q0: {
      type: "choice",
      choice: "name",
      probabilities: { lives_in: 0, none: 0.07, name: 0.93, birthday: 0 },
      confidence: 0.91,
    },
  },
  usage: { input_tokens: 468, output_tokens: 93, cost: 0.000019656 },
  id: "gen-dec-1790593015-gUH3Pqcofzyq8db2BORa",
  provider: "TypeSafe",
};

function answer(choice: ChoiceAnswer["choice"], p: number): ChoiceAnswer {
  return { choice, p, confidence: null, probabilities: { [choice]: p } };
}

describe("slotCriteria", () => {
  it("offers exactly the eight slots with their descriptions, plus none", () => {
    const criteria = slotCriteria();
    expect(Object.keys(criteria)).toEqual([...SLOTS, NO_SLOT]);
    for (const slot of SLOTS) expect(criteria[slot]).toBe(SLOT_DESCRIPTIONS[slot]);
    expect(criteria[NO_SLOT]).toMatch(/single-valued/);
  });
});

describe("buildSlotRequest", () => {
  it("relation mode sends the relation split to words, and the question verbatim", () => {
    const request = buildSlotRequest([{ relation: "Lives_In" }], "relation");
    expect(request.model).toBe("typesafe/jev-1.13");
    expect(request.state).toEqual({ relation: "lives in" });
    expect(request.questions.q0?.instructions).toBe(SLOT_QUESTION);
    expect(request.questions.q0?.type).toBe("choice");
  });

  it("fact mode sends about | relation | value", () => {
    const request = buildSlotRequest(
      [{ relation: "born_in", fact: { about: "user", relation: "born_in", value: "Lagos" } }],
      "fact",
    );
    expect(request.state).toEqual({ about: "user", relation: "born in", value: "Lagos" });
  });

  it("batches several items into one call, one question per state key", () => {
    const request = buildSlotRequest([{ relation: "visited" }, { relation: "works_at" }], "relation");
    expect(request.state).toEqual({ r0: "visited", r1: "works at" });
    expect(Object.keys(request.questions)).toEqual(["q0", "q1"]);
    expect(request.questions.q1?.instructions).toContain('"r1"');
    expect(request.questions.q1?.instructions).toContain(SLOT_QUESTION);
  });

  it("refuses an empty batch", () => {
    expect(() => buildSlotRequest([], "relation")).toThrow();
  });
});

describe("parseSlotResponse", () => {
  it("reads the live shape, and thresholds on the chosen option's probability, not confidence", () => {
    const parsed = parseSlotResponse(LIVE, ["q0"]);
    const q0 = parsed.answers.get("q0");
    expect(q0?.choice).toBe("name");
    expect(q0?.p).toBe(0.93);
    expect(q0?.confidence).toBe(0.91);
    expect(parsed.cost).toBeCloseTo(0.000019656, 12);
    expect(parsed.inputTokens).toBe(468);
    expect(parsed.model).toBe("typesafe/jev-1.13-20260917");
  });

  it("tolerates rounded probabilities that do not sum to 1", () => {
    const body = { answers: { q0: { type: "choice", choice: "role", probabilities: { role: 0.34, none: 0.33, name: 0.32 } } } };
    expect(parseSlotResponse(body, ["q0"]).answers.get("q0")?.p).toBe(0.34);
  });

  it("falls back to confidence without a distribution, and to NaN without either", () => {
    const withConfidence = { answers: { q0: { type: "choice", choice: "role", confidence: 0.8 } } };
    expect(parseSlotResponse(withConfidence, ["q0"]).answers.get("q0")?.p).toBe(0.8);
    const bare = { answers: { q0: { type: "choice", choice: "role" } } };
    expect(parseSlotResponse(bare, ["q0"]).answers.get("q0")?.p).toBeNaN();
  });

  it("treats a missing cost as zero rather than failing", () => {
    const body = { answers: { q0: { type: "choice", choice: "none" } } };
    expect(parseSlotResponse(body, ["q0"]).cost).toBe(0);
  });

  it("rejects a choice outside the offered options", () => {
    const body = { answers: { q0: { type: "choice", choice: "hobby" } } };
    expect(() => parseSlotResponse(body, ["q0"])).toThrow(/not an offered option/);
  });

  it("rejects a prototype key posing as a choice", () => {
    const body = { answers: { q0: { type: "choice", choice: "constructor" } } };
    expect(() => parseSlotResponse(body, ["q0"])).toThrow(/not an offered option/);
  });

  it("rejects a missing or mistyped answer", () => {
    expect(() => parseSlotResponse({ answers: {} }, ["q0"])).toThrow(/no choice answer/);
    expect(() => parseSlotResponse({ answers: { q0: { type: "noul", noul: 1 } } }, ["q0"])).toThrow();
    expect(() => parseSlotResponse(null, ["q0"])).toThrow();
    expect(() => parseSlotResponse({}, ["q0"])).toThrow(/no answers/);
  });
});

describe("slotFromAnswer — the threshold rule", () => {
  it("maps at or above the threshold, not below", () => {
    expect(slotFromAnswer(answer("lives_in", 0.9), 0.9)).toBe("lives_in");
    expect(slotFromAnswer(answer("lives_in", 0.89), 0.9)).toBeNull();
  });

  it("never promotes none, however unsure", () => {
    expect(slotFromAnswer(answer(NO_SLOT, 0.2), 0)).toBeNull();
  });

  it("puts a NaN probability below every threshold", () => {
    expect(slotFromAnswer(answer("role", Number.NaN), 0)).toBeNull();
  });

  it("answers null for no answer at all", () => {
    expect(slotFromAnswer(undefined, 0.5)).toBeNull();
  });
});

describe("assignSlotWithJev — synonym table in front", () => {
  it("a table hit never consults the model, even when the model disagrees", () => {
    expect(assignSlotWithJev("lives_in", answer("birthday", 0.99), 0.9)).toEqual({ slot: "lives_in", via: "synonym" });
    expect(assignSlotWithJev("First_Name", undefined, 0.9)).toEqual({ slot: "name", via: "synonym" });
  });

  it("falls through to Jev, and to no slot", () => {
    expect(assignSlotWithJev("current_city", answer("lives_in", 0.95), 0.9)).toEqual({ slot: "lives_in", via: "jev" });
    expect(assignSlotWithJev("visited", answer(NO_SLOT, 0.95), 0.9)).toEqual({ slot: null, via: "none" });
  });
});

describe("decisionCacheKey", () => {
  it("is stable for the same request and moves with any input byte", () => {
    const a = buildSlotRequest([{ relation: "lives_in" }], "relation");
    expect(decisionCacheKey(a)).toBe(decisionCacheKey(buildSlotRequest([{ relation: "lives_in" }], "relation")));
    expect(decisionCacheKey(a)).not.toBe(decisionCacheKey(buildSlotRequest([{ relation: "works_at" }], "relation")));
    expect(decisionCacheKey(a)).not.toBe(decisionCacheKey({ ...a, model: "typesafe/jev-1.14" }));
    const reworded = structuredClone(a);
    reworded.questions.q0!.criteria.role = "something else";
    expect(decisionCacheKey(a)).not.toBe(decisionCacheKey(reworded));
  });
});

describe("DecisionCache", () => {
  it("round-trips, appends, and survives a torn line", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-cache-")), "decisions.ndjson");
    const first = new DecisionCache(path);
    first.put({ k: "a", body: LIVE, latencyMs: 12 });
    first.put({ k: "b", body: LIVE, latencyMs: 34 });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"k":"torn`);
    const second = new DecisionCache(path);
    expect(second.size).toBe(2);
    expect(second.get("b")?.latencyMs).toBe(34);
  });
});

describe("SpendMeter", () => {
  it("refuses a call that would cross the cap, counting in-flight estimates", () => {
    const meter = new SpendMeter(1, 0.4);
    meter.reserve();
    meter.reserve();
    expect(() => meter.reserve()).toThrow(SpendCapError);
    meter.settle(0.1);
    meter.release();
    expect(meter.spent).toBeCloseTo(0.1);
    meter.reserve();
  });
});

describe("isRetryableStatus", () => {
  it("retries rate limits and upstream errors, not client errors", () => {
    for (const status of [408, 429, 500, 502, 503, 524, 529]) expect(isRetryableStatus(status)).toBe(true);
    for (const status of [400, 401, 402, 403, 404, 413]) expect(isRetryableStatus(status)).toBe(false);
  });
});

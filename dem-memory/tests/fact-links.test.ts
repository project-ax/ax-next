import { describe, expect, it } from "vitest";
import {
  LINK_OPTIONS,
  LINK_OPTION_SET,
  buildLinkRequest,
  candidatePairs,
  displayAbout,
  factTokens,
  linkFromAnswer,
  type LinkFact,
} from "../bench/fact-links.js";
import { parseChoiceResponse, type OptionAnswer } from "../bench/jev.js";

/** Hermetic: hand-built vectors, no network. */

const fact = (id: string, when: string, about = "user:owner", relation = "r", value = "v"): LinkFact => ({
  id,
  about,
  relation,
  value,
  when,
});
const vec = (...xs: number[]): Float32Array => Float32Array.from(xs);
const answer = (choice: (typeof LINK_OPTIONS)[number], p: number): OptionAnswer<(typeof LINK_OPTIONS)[number]> => ({
  choice,
  p,
  confidence: null,
  probabilities: { [choice]: p },
});

describe("buildLinkRequest", () => {
  it("shows both facts with date only, relation in words, and the owner id hidden", () => {
    const request = buildLinkRequest(
      fact("a", "2023-01-11T12:00:00.000Z", "user:owner-1", "egg_stock", "30 dozen"),
      fact("b", "2023-03-15T12:00:00.000Z", "user:owner-1", "has_egg_stock", "20 dozen"),
    );
    expect(request.state).toEqual({
      A: { when: "2023-01-11", about: "user", relation: "egg stock", value: "30 dozen" },
      B: { when: "2023-03-15", about: "user", relation: "has egg stock", value: "20 dozen" },
    });
    expect(Object.keys(request.questions.rel?.criteria ?? {})).toEqual([...LINK_OPTIONS]);
  });

  it("keeps a non-user subject as is", () => {
    expect(displayAbout("rachel")).toBe("rachel");
    expect(displayAbout("user")).toBe("user");
  });
});

describe("linkFromAnswer", () => {
  it("links updates and same_event at or above the threshold only", () => {
    expect(linkFromAnswer(answer("updates", 0.7), 0.7)).toBe("updates");
    expect(linkFromAnswer(answer("same_event", 0.69), 0.7)).toBeNull();
  });

  it("never links both_true, and treats no answer as no link", () => {
    expect(linkFromAnswer(answer("both_true", 0.99), 0)).toBeNull();
    expect(linkFromAnswer(undefined, 0)).toBeNull();
  });

  it("parses a live-shaped link answer with the generic parser", () => {
    const body = { answers: { rel: { type: "choice", choice: "updates", probabilities: { updates: 0.93, both_true: 0.07 } } } };
    const parsed = parseChoiceResponse(body, ["rel"], LINK_OPTION_SET);
    expect(linkFromAnswer(parsed.answers.get("rel"), 0.7)).toBe("updates");
    expect(() => parseChoiceResponse({ answers: { rel: { type: "choice", choice: "lives_in" } } }, ["rel"], LINK_OPTION_SET)).toThrow();
  });
});

describe("candidatePairs", () => {
  const vectors = new Map([
    ["old", vec(1, 0)],
    ["new", vec(0.9, 0.1)],
    ["far", vec(0, 1)],
    ["other-subject", vec(1, 0)],
    ["later", vec(1, 0)],
  ]);

  it("pairs a fact only with EARLIER facts of the same subject above the floor", () => {
    const facts = [
      fact("new", "2023-02-01"),
      fact("old", "2023-01-01"),
      fact("far", "2022-12-01"),
      fact("other-subject", "2022-12-01", "assistant"),
    ];
    const pairs = candidatePairs(facts, vectors, { k: 5, minCosine: 0.5 });
    expect(pairs.map((p) => `${p.a}->${p.b}`)).toEqual(["old->new"]);
  });

  it("keeps the k nearest, nearest first", () => {
    const facts = [fact("old", "2023-01-01"), fact("new", "2023-01-02"), fact("later", "2023-01-03")];
    const pairs = candidatePairs(facts, vectors, { k: 1, minCosine: 0 });
    expect(pairs.filter((p) => p.b === "later").map((p) => p.a)).toEqual(["old"]);
  });

  it("orders ties on date by input order, and skips facts without a vector", () => {
    const facts = [fact("old", "2023-01-01"), fact("novec", "2023-01-01"), fact("later", "2023-01-01")];
    const pairs = candidatePairs(facts, vectors, { k: 5, minCosine: 0 });
    expect(pairs.map((p) => `${p.a}->${p.b}`)).toEqual(["old->later"]);
  });

  it("honours a subject filter", () => {
    const facts = [fact("other-subject", "2023-01-01", "assistant"), fact("later", "2023-01-02", "assistant")];
    expect(candidatePairs(facts, vectors, { k: 5, minCosine: 0, about: (a) => a.startsWith("user") })).toEqual([]);
  });
});

describe("candidatePairs — lexical channel", () => {
  const withText = (id: string, when: string, relation: string, value: string): LinkFact => ({ id, about: "user:owner", relation, value, when });
  // Vectors make the "plans" distractor the nearest neighbour, the way gemini did for the sneakers pair.
  const vectors = new Map([
    ["old", vec(0, 1)],
    ["distractor", vec(1, 0.05)],
    ["new", vec(1, 0)],
  ]);
  const facts = [
    withText("old", "2023-08-11", "stores_sneakers", "old sneakers kept under the bed"),
    withText("distractor", "2023-09-01", "plans_inventory", "plans to take inventory of the garage this weekend"),
    withText("new", "2023-11-30", "plans_to_organize", "closet this weekend, storing old sneakers in a shoe rack"),
  ];

  it("finds a pair that shares a rare word even when the vectors rank it last", () => {
    const vectorOnly = candidatePairs(facts, vectors, { k: 1, minCosine: -1 }).filter((p) => p.b === "new");
    expect(vectorOnly.map((p) => p.a)).toEqual(["distractor"]);
    const hybrid = candidatePairs(facts, vectors, { k: 1, minCosine: -1, lexicalK: 1 }).filter((p) => p.b === "new");
    expect(hybrid.map((p) => p.a).sort()).toEqual(["distractor", "old"]);
    expect(hybrid.find((p) => p.a === "old")?.lexical).toBeGreaterThan(0);
  });

  it("does not duplicate a pair both channels choose", () => {
    const pairs = candidatePairs(facts, vectors, { k: 2, minCosine: -1, lexicalK: 2 }).filter((p) => p.b === "new");
    expect(new Set(pairs.map((p) => p.a)).size).toBe(pairs.length);
  });

  it("ignores stopwords and folds plurals", () => {
    expect([...factTokens({ relation: "plans_to_organize", value: "the user plans sneakers" })].sort()).toEqual(["organize", "sneaker"]);
  });
});

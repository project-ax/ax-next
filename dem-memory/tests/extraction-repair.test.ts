import { describe, expect, it } from "vitest";
import { coerceNetworkValue, describeValidationFailure, buildRepairPrompt } from "../bench/extraction.js";

/**
 * gpt-4.1-nano reads the prompt's "USER facts / ASSISTANT facts" framing as if it named the
 * `network` enum, and emits `network: "user"` for every fact. The generic retry ("was not a
 * valid JSON object … Every fact MUST include network") did not tell it WHICH field was wrong
 * or WHAT it had actually sent, so the repair attempt reproduced the same output and the whole
 * session was lost. A weak model can only self-correct from a specific complaint.
 */
describe("extraction repair prompt", () => {
  it("names the offending field rather than saying only that something was invalid", () => {
    // `network` is no longer a way to fail — it is coerced (see "network coercion" below) —
    // so the remaining failures are missing or wrong-typed required fields.
    const detail = describeValidationFailure({
      facts: [{ network: "world", subject: "sam", predicate: "likes", object: "tea" }],
    });
    expect(detail).toMatch(/facts\[\]\.validStart/);
    expect(detail).not.toBe("");
  });

  it("collapses one repeated mistake instead of printing it once per fact", () => {
    const facts = Array.from({ length: 30 }, () => ({
      network: "world",
      subject: "sam",
      predicate: "likes",
      object: "tea",
      invalidatesPrevious: false,
    }));
    const detail = describeValidationFailure({ facts });
    // One line per distinct (path-shape, message), not 30 near-identical lines that would
    // crowd the transcript out of the repair prompt's context.
    expect(detail.split("\n").length).toBeLessThanOrEqual(6);
    expect(detail).toMatch(/30/);
  });

  it("reports a payload that is not an object at all", () => {
    expect(describeValidationFailure("[]")).toMatch(/facts/);
    expect(describeValidationFailure(null)).toMatch(/facts/);
  });

  it("returns empty for a payload that actually validates", () => {
    expect(
      describeValidationFailure({
        facts: [
          {
            network: "world",
            subject: "sam",
            predicate: "likes",
            object: "tea",
            validStart: "2023-01-01T00:00:00.000Z",
            invalidatesPrevious: false,
          },
        ],
      }),
    ).toBe("");
  });

  it("puts the specific complaint into the repair prompt, ahead of the raw reply", () => {
    const prompt = buildRepairPrompt({
      dialogue: "user: hi",
      now: "2023-01-01T00:00:00.000Z",
      previous: '{"facts":[{"network":"user"}]}',
      detail: 'facts[].network: received "user", expected one of world | experience | opinion (30 facts)',
    });
    expect(prompt).toMatch(/facts\[\]\.network/);
    expect(prompt.indexOf("facts[].network")).toBeLessThan(
      prompt.indexOf("Your previous reply (first 600 chars)"),
    );
    expect(prompt).toMatch(/network.*speaker|speaker.*network/is);
  });
});

/**
 * `network` never filters retrieval — `recall.ts` reads none of it, and `reflect.ts` maps both
 * `world` and `experience` onto the same "FACT" display tag. So a wrong network costs a tag,
 * while a rejected payload costs the entire session. gpt-4.1-nano emits `network: "user"` and
 * `network: "assistant"` even after a pointed correction, which made it lose 2 of 4 sessions
 * outright. Coerce by the contract's own definitions, and COUNT it so a model that cannot hold
 * the schema shows up as a number rather than as a quietly worse score.
 */
describe("network coercion", () => {
  it("maps the speaker-confusion values onto the network the contract assigns them", () => {
    expect(coerceNetworkValue("assistant")).toBe("experience");
    expect(coerceNetworkValue("user")).toBe("experience");
    expect(coerceNetworkValue("preference")).toBe("opinion");
    expect(coerceNetworkValue("belief")).toBe("opinion");
  });

  it("passes the three legal values through untouched", () => {
    expect(coerceNetworkValue("world")).toBe("world");
    expect(coerceNetworkValue("experience")).toBe("experience");
    expect(coerceNetworkValue("opinion")).toBe("opinion");
  });

  it("falls back to world for anything it cannot place", () => {
    expect(coerceNetworkValue("wibble")).toBe("world");
    expect(coerceNetworkValue(42)).toBe("world");
  });

  it("is applied by the fact coercion, so a bad network no longer fails the payload", () => {
    const detail = describeValidationFailure({
      facts: [
        {
          network: "assistant",
          subject: "assistant",
          predicate: "recommended",
          object: "Mod Podge",
          validStart: "2023-01-01T00:00:00.000Z",
          invalidatesPrevious: false,
        },
      ],
    });
    expect(detail).toBe("");
  });
});

/**
 * A reply that is valid JSON but carries the wrong top-level key used to produce zero facts
 * SILENTLY: `raw.facts?.map(...) ?? []` yields `[]`, an empty array passes
 * IngestionPayloadSchema, nothing throws, the repair retry never fires, and the empty result is
 * written to the fact cache — so every later run serves "this session had nothing in it".
 * An extractor that answers `{"memories":[…]}` is indistinguishable from a session of small
 * talk. The two must be distinguishable: a missing `facts` array is malformed and must retry;
 * an explicitly empty one is a real answer and must not.
 */
describe("missing facts array", () => {
  it("is a validation failure, not an empty extraction", () => {
    expect(describeValidationFailure({ memories: [] })).not.toBe("");
    expect(describeValidationFailure({ memories: [] })).toMatch(/facts/);
  });

  it("still accepts an explicitly empty facts array — a session with nothing worth keeping", () => {
    expect(describeValidationFailure({ facts: [] })).toBe("");
  });

  it("rejects a facts value that is not an array", () => {
    expect(describeValidationFailure({ facts: "none" })).not.toBe("");
    expect(describeValidationFailure({ facts: null })).not.toBe("");
  });
});
